/**
 * inject.ts — Transport builder (the injection axis).
 *
 * `buildTransport(transport, resolved)` is the SINGLE pure function that
 * maps a `TransportConfig` + `ResolvedCredential` → an MCP SDK `Transport`
 * instance ready to pass to `client.connect()`.
 *
 * Implemented:
 *   stdio  + env/argv/files injection
 *   http   + header injection (C2)
 *   http   + native (OAuth) injection (C3)
 *
 * Design notes:
 *   - env merge: `transport.env` (base env) is applied FIRST; `resolved.vars`
 *     (credential vars) are overlaid on top. Credentials win on key collision —
 *     this matches the principle of least surprise (the auth config is
 *     authoritative over static env).
 *   - argv append: `transport.args` (static args) come first; `resolved.args`
 *     (credential args) are appended. Order matters for many CLI tools.
 *   - http headers merge: `transport.headers` (non-secret static headers) come
 *     first; injected credential headers overlay on top. Credentials win on key
 *     collision (same principle as env).
 *   - The function is pure — it never has side effects and always returns a new
 *     transport instance. Idempotent to call multiple times.
 */

import net from 'node:net';

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { TransportConfig } from './config.js';
import type { ResolvedCredential } from './providers/provider.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Result of `buildTransport`.
 *
 * For ordinary transports: `{ transport, httpTransport: undefined }`.
 * For http + native (OAuth): `{ transport, httpTransport }` — the caller
 * MUST wire the OAuthProvider into `httpTransport` before calling
 * `client.connect(transport)`.
 */
export interface BuildTransportResult {
  transport: Transport;
  /** Set when the transport is a StreamableHTTPClientTransport (for OAuth wiring). */
  httpTransport?: StreamableHTTPClientTransport;
}

/**
 * Build an MCP SDK `Transport` from the connector's transport config and the
 * resolved credential. This is the ONLY place that constructs transports.
 *
 * @param transport - The parsed transport configuration for this connector.
 * @param resolved  - The credential resolved by the CredentialProvider
 *                    (or `{ apply: 'none' }` when there is no auth).
 * @returns A `BuildTransportResult`. For OAuth (http + native), `httpTransport`
 *          is set — the caller must call `oauthProvider.wireTransport(httpTransport)`
 *          before connecting.
 * @throws Error when the transport kind or credential apply type is not supported.
 */
export function buildTransport(
  transport: TransportConfig,
  resolved: ResolvedCredential,
): BuildTransportResult {
  if (transport.kind === 'stdio') {
    return { transport: buildStdioTransport(transport, resolved) };
  }

  if (transport.kind === 'http') {
    return buildHttpTransport(transport, resolved);
  }

  // TypeScript exhaustiveness guard.
  const _exhaustive: never = transport;
  throw new Error(`Unknown transport kind: ${JSON.stringify(_exhaustive)}`);
}

// ---------------------------------------------------------------------------
// stdio transport builder
// ---------------------------------------------------------------------------

function buildStdioTransport(
  transport: Extract<TransportConfig, { kind: 'stdio' }>,
  resolved: ResolvedCredential,
): Transport {
  // --- env merge: transport.env first, then resolved.vars on top ---
  let mergedEnv: Record<string, string> | undefined;

  if (transport.env !== undefined || resolved.apply === 'env') {
    mergedEnv = {
      ...(transport.env ?? {}),
      ...(resolved.apply === 'env' ? resolved.vars : {}),
    };
  }

  // --- argv append: transport.args first, then resolved.args appended ---
  let mergedArgs: string[] | undefined;
  const baseArgs = transport.args ?? [];
  const credArgs = resolved.apply === 'argv' ? resolved.args : [];

  if (baseArgs.length > 0 || credArgs.length > 0) {
    mergedArgs = [...baseArgs, ...credArgs];
  }

  // Reject apply types that require a non-stdio path.
  if (resolved.apply === 'headers') {
    throw new Error(
      'header credential injection requires an http transport; stdio transports use env/argv/file injection',
    );
  }
  if (resolved.apply === 'native') {
    throw new Error(
      'OAuth (native) credential apply requires an http transport; stdio transport does not support OAuth',
    );
  }

  // files credential: the files are already on disk (materialized in resolve()).
  // Merge the pointer env-vars into the child env so the child can locate them.
  // Precedence: transport.env (base) → resolved.vars (pointer vars) on top.
  if (resolved.apply === 'files') {
    const filesEnv: Record<string, string> = {
      ...(transport.env ?? {}),
      ...resolved.vars,
    };
    // Only pass env if there is something to pass (vars may be empty).
    const hasEnv = Object.keys(filesEnv).length > 0;
    return new StdioClientTransport({
      command: transport.command,
      ...(mergedArgs !== undefined ? { args: mergedArgs } : {}),
      ...(hasEnv ? { env: filesEnv } : {}),
    });
  }

  // resolved.apply === 'env' | 'argv' | 'none' — all handled above.

  return new StdioClientTransport({
    command: transport.command,
    ...(mergedArgs !== undefined ? { args: mergedArgs } : {}),
    ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
  });
}

// ---------------------------------------------------------------------------
// MCP HTTP transport URL security helpers
// ---------------------------------------------------------------------------

/** Known RFC-1918 and link-local IPv4 prefixes. */
const PRIVATE_IPV4_PREFIXES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Return true if `host` is an IPv4 private / link-local address, an IPv6
 * private / link-local address, or resolves to one of those (we only check
 * literals here — no DNS lookup at build time, keeping this pure/sync).
 */
function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets
  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIPv4(bare)) {
    return PRIVATE_IPV4_PREFIXES.some((re) => re.test(bare));
  }
  if (net.isIPv6(bare)) {
    const low = bare.toLowerCase();
    if (low === '::1') return false; // loopback — handled separately (allowed)
    if (/^f[cd]/.test(low.split(':')[0] ?? '')) return true; // unique-local fc00::/7
    if (/^fe[89ab]/.test(low.split(':')[0] ?? '')) return true; // link-local fe80::/10
    if (/^ff/.test(low.split(':')[0] ?? '')) return true; // multicast
    if (low.startsWith('2001:db8:')) return true; // documentation
    if (low.startsWith('64:ff9b::')) return true; // NAT64
  }
  return false;
}

/** True when the host is localhost / loopback (IPv4 or IPv6). */
function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

/**
 * Validate an MCP HTTP transport URL for security:
 *
 *  - plain `http://` is rejected unless the host is localhost / 127.0.0.1 / ::1
 *    (local dev is fine; `http://` to a remote host is not).
 *  - RFC-1918 / link-local hosts are allowed but produce a `console.warn`
 *    (they are suspicious — the operator should know).
 *
 * Throws a descriptive Error on rejection so the caller can skip or surface it.
 */
export function validateMcpHttpUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`[mcp] HTTP transport URL is not a valid URL: '${rawUrl}'`);
  }

  const { hostname, protocol } = url;

  // Require https:// unless localhost/loopback.
  if (protocol === 'http:' && !isLoopbackHost(hostname)) {
    throw new Error(
      `[mcp] HTTP transport URL must use https:// for non-localhost hosts (got '${rawUrl}'). ` +
        `Plain http:// to a remote host is not permitted.`,
    );
  }

  // Warn (but allow) RFC-1918 / link-local private addresses.
  if (isPrivateHost(hostname)) {
    console.warn(
      `[mcp] HTTP transport URL '${rawUrl}' resolves to a private/link-local address — ` +
        `allowed for internal deployments, but verify this is intentional.`,
    );
  }
}

// ---------------------------------------------------------------------------
// http transport builder
// ---------------------------------------------------------------------------

/**
 * Build a StreamableHTTPClientTransport from an http transport config and
 * a resolved credential.
 *
 * Header merge: transport.headers (non-secret static headers) come first;
 * resolved.headers (credential headers) overlay on top. This matches the
 * env-merge convention: credentials win on key collision.
 *
 * Credential apply types that are stdio-only (env/argv/files) are rejected
 * with a clear error — those channels are meaningless over HTTP.
 *
 * native (OAuth): passes the `OAuthClientProvider` as `authProvider` to the
 * SDK transport (C3). The caller MUST call `oauthProvider.wireTransport`
 * with the returned `httpTransport` BEFORE calling `client.connect`.
 */
function buildHttpTransport(
  transport: Extract<TransportConfig, { kind: 'http' }>,
  resolved: ResolvedCredential,
): BuildTransportResult {
  // Security: validate the URL before building the transport.
  validateMcpHttpUrl(transport.url);

  // Reject stdio-only apply types.
  if (resolved.apply === 'env' || resolved.apply === 'argv' || resolved.apply === 'files') {
    throw new Error(
      `env/argv/file injection is stdio-only; http servers use header or oauth injection` +
        ` (got apply='${resolved.apply}' for url '${transport.url}')`,
    );
  }

  if (resolved.apply === 'native') {
    // C3: wire the OAuthClientProvider into the SDK transport.
    // `resolved.oauth` is typed as OAuthClientProvider in the ResolvedCredential
    // discriminated union (C33 fix) — no cast needed.
    const authProvider = resolved.oauth;

    // Static headers (non-secret) may still be present alongside OAuth.
    const hasHeaders = transport.headers !== undefined && Object.keys(transport.headers).length > 0;

    const httpTransport = new StreamableHTTPClientTransport(new URL(transport.url), {
      authProvider,
      ...(hasHeaders && transport.headers !== undefined
        ? { requestInit: { headers: transport.headers as Record<string, string> } }
        : {}),
    });

    // Cast to Transport for the pool; also return the concrete type so the
    // dispatcher can call wireTransport on the OAuthProvider.
    return {
      transport: httpTransport as unknown as Transport,
      httpTransport,
    };
  }

  // resolved.apply === 'headers' | 'none'

  // Merge static transport headers (non-secret) with credential headers (secret on top).
  const mergedHeaders: Record<string, string> = {
    ...(transport.headers ?? {}),
    ...(resolved.apply === 'headers' ? resolved.headers : {}),
  };

  const hasHeaders = Object.keys(mergedHeaders).length > 0;

  // Cast to Transport: StreamableHTTPClientTransport's sessionId getter returns
  // `string | undefined` which conflicts with Transport's `sessionId?: string`
  // under exactOptionalPropertyTypes. Both are functionally equivalent; the
  // cast is safe — the SDK implements the full Transport interface.
  return {
    transport: new StreamableHTTPClientTransport(new URL(transport.url), {
      ...(hasHeaders ? { requestInit: { headers: mergedHeaders } } : {}),
    }) as unknown as Transport,
  };
}
