/**
 * Egress proxy — Hono service that:
 *   1. Verifies the sandbox JWT (from Authorization: Bearer header).
 *   2. Looks up the matching lease (hot store → Postgres fallback).
 *   3. Resolves the credential (reads oauth_tokens.access_token via @sym/db).
 *   4. Injects the Authorization header into the outbound request.
 *   5. Strips hop-by-hop headers from both inbound and outbound.
 *   6. Forwards the request to the real destination.
 *   7. Logs the audit trail (destination, status, bytes) — NO token values logged.
 *
 * Network topology (enforced by Docker network config, not this code):
 *   sandbox → [this proxy only] → internet
 *   internet → [sandbox is unreachable directly]
 *
 * Security invariants:
 * - Denies any request without a valid, unexpired JWT matching an active lease.
 * - Never logs or returns token values.
 * - Strips hop-by-hop headers to prevent header smuggling.
 * - Duplicate request shapes (same method/URL/body) are NOT rejected — the
 *   requester-bound credential is the security boundary (see security-policy.md).
 *
 * Hop-by-hop headers to strip (RFC 7230 §6.1 + proxy-specific):
 *   Connection, Keep-Alive, Proxy-Authenticate, Proxy-Authorization,
 *   Proxy-Connection, TE, Trailer, Transfer-Encoding, Upgrade
 */

import { oauthTokens } from '@sym/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { SandboxJwtError, verifySandboxJwt } from './jwt.js';

import type { SandboxJwtConfig } from './jwt.js';
import type { LeaseStore } from './lease-store.js';
import type { SandboxJwtId } from '@sym/contracts';
import type { Database } from '@sym/db';

/** Headers that must never be forwarded (RFC 7230 §6.1 hop-by-hop). */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Strip hop-by-hop headers from a Headers-like object. Returns a plain Record. */
function stripHopByHop(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Audit record emitted per proxied request. No token values, no secrets.
 * Callers may wire this to OpenTelemetry or a logger.
 */
export interface EgressAuditRecord {
  sandboxJwtId: string;
  requester: string;
  provider: string;
  domain: string;
  method: string;
  destination: string;
  status: number;
  responseBodyBytes: number;
  durationMs: number;
}

export interface EgressProxyConfig {
  jwt: SandboxJwtConfig;
  /** Called after each proxied request for audit/observability. Never throws. */
  onAudit?: (record: EgressAuditRecord) => void;
  /**
   * Fetch function (injectable for testing — never make real network calls in tests).
   * Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
}

/**
 * Build the Hono egress proxy app.
 *
 * The sandbox routes all outbound traffic through:
 *   POST /proxy  with body: { method, url, headers, body? }
 *
 * The sandbox JWT is sent in Authorization: Bearer <token>.
 */
export function createEgressProxy(
  store: LeaseStore,
  db: Database,
  config: EgressProxyConfig,
): Hono {
  const app = new Hono();
  const fetchImpl = config.fetch ?? fetch;

  app.post('/proxy', async (c) => {
    const t0 = Date.now();

    // --- 1. Extract and verify the sandbox JWT ---
    const authHeader = c.req.header('authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return c.json(
        { error: 'missing_token', message: 'Authorization: Bearer <token> required' },
        401,
      );
    }
    const token = authHeader.slice(7);

    let identity: Awaited<ReturnType<typeof verifySandboxJwt>>;
    try {
      identity = await verifySandboxJwt(token, config.jwt);
    } catch (err) {
      if (err instanceof SandboxJwtError) {
        const code = err.code === 'expired' ? 'token_expired' : 'token_invalid';
        return c.json({ error: code, message: err.message }, 401);
      }
      return c.json({ error: 'token_invalid', message: 'JWT verification failed' }, 401);
    }

    // --- 2. Parse the egress request body ---
    let body: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string; // base64-encoded
    };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return c.json({ error: 'bad_request', message: 'Request body must be JSON' }, 400);
    }

    if (!body.method || !body.url) {
      return c.json({ error: 'bad_request', message: 'method and url are required' }, 400);
    }

    // --- 3. Look up the lease in the hot store ---
    const lease = store.get(identity.jti as SandboxJwtId);
    if (!lease) {
      return c.json(
        {
          error: 'egress_denied',
          message: 'No active lease found for this sandbox JWT',
          code: 'lease_expired',
        },
        403,
      );
    }

    // Validate domain matches the lease (prevent SSRF to unlicensed domains).
    let destUrl: URL;
    try {
      destUrl = new URL(body.url);
    } catch {
      return c.json({ error: 'bad_request', message: 'Invalid destination URL' }, 400);
    }
    const destHost = destUrl.hostname;
    if (destHost !== lease.domain && !destHost.endsWith('.' + lease.domain)) {
      return c.json(
        {
          error: 'egress_denied',
          message: `Destination ${destHost} is not covered by lease domain ${lease.domain}`,
        },
        403,
      );
    }

    // --- 4. Resolve the credential ---
    let accessToken: string;
    try {
      const rows = await db
        .select({ accessToken: oauthTokens.accessToken })
        .from(oauthTokens)
        .where(eq(oauthTokens.id, lease.oauthTokenId as string))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return c.json({ error: 'egress_denied', message: 'OAuth token not found' }, 403);
      }
      accessToken = row.accessToken;
    } catch (cause) {
      console.error('[egress-proxy] token resolve error', { cause });
      return c.json({ error: 'internal_error', message: 'Failed to resolve credential' }, 500);
    }

    // --- 5. Build outbound headers: strip hop-by-hop, inject Authorization ---
    const inboundHeaders = new Headers(body.headers ?? {});
    const outboundHeaders = stripHopByHop(inboundHeaders);
    // Inject the real bearer token — sandbox never sees it
    outboundHeaders['authorization'] = `Bearer ${accessToken}`;

    // --- 6. Forward the request ---
    let upstreamResponse: Response;
    try {
      const fetchInit: RequestInit = {
        method: body.method,
        headers: outboundHeaders,
        // Do NOT auto-follow redirects: a leased host could 3xx us to an
        // unleased domain, bypassing the lease.domain check above. Return the
        // 3xx to the sandbox unfollowed — if it wants the next hop it must
        // re-enter /proxy, where the domain gate runs again.
        redirect: 'manual',
      };
      if (body.body) {
        fetchInit.body = Buffer.from(body.body, 'base64');
      }
      upstreamResponse = await fetchImpl(body.url, fetchInit);
    } catch (cause) {
      console.error('[egress-proxy] upstream fetch error', { cause });
      return c.json({ error: 'upstream_error', message: 'Failed to reach upstream' }, 502);
    }

    // --- 7. Return the upstream response, stripping hop-by-hop ---
    const responseHeaders = stripHopByHop(upstreamResponse.headers);
    const responseBody = await upstreamResponse.arrayBuffer();
    const responseBytes = responseBody.byteLength;

    // Audit — safe metadata only, no token values
    const auditRecord: EgressAuditRecord = {
      sandboxJwtId: identity.jti,
      requester: identity.requester,
      provider: lease.provider,
      domain: lease.domain,
      method: body.method,
      destination: body.url,
      status: upstreamResponse.status,
      responseBodyBytes: responseBytes,
      durationMs: Date.now() - t0,
    };
    try {
      config.onAudit?.(auditRecord);
    } catch {
      // Audit failures must never crash the proxy
    }

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  });

  // Health check
  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
