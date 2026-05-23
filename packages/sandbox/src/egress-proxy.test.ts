/**
 * Egress proxy tests.
 *
 * - All hermetic: fetch is mocked, DB is mocked via a stub, no real Docker.
 * - Tests cover: credential injection, hop-by-hop stripping, deny-without-lease,
 *   JWT invalid, JWT expired, wrong-key, domain mismatch, audit logging.
 *
 * Hono testing: we call app.fetch() directly (the Hono test pattern).
 */

import { describe, expect, it, vi } from 'vitest';

import { createEgressProxy } from './egress-proxy.js';
import { mintSandboxJwt } from './jwt.js';
import { LeaseStore } from './lease-store.js';

import type { SandboxJwtConfig } from './jwt.js';
import type {
  LeaseId,
  LeaseRef,
  OAuthTokenId,
  SandboxId,
  SandboxJwtId,
  SlackUserId,
  TurnId,
} from '@sym/contracts';
import type { Database } from '@sym/db';

const SECRET = 'egress-proxy-test-secret-long-enough-for-hmac-32+chars';
const JWT_CONFIG: SandboxJwtConfig = { secret: SECRET };

/** Build a minimal Drizzle-like DB stub that returns a fake access token. */
function makeDbStub(accessToken: string): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ accessToken }]),
        }),
      }),
    }),
  } as unknown as Database;
}

function makeEmptyDbStub(): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Database;
}

function makeLease(overrides: Partial<LeaseRef> = {}): LeaseRef {
  return {
    leaseId: 'lease_1' as LeaseId,
    sandboxJwtId: 'jti_placeholder' as SandboxJwtId, // replaced by caller
    provider: 'github',
    domain: 'api.github.com',
    oauthTokenId: 'tok_1' as OAuthTokenId,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

async function makeToken(
  overrides: Partial<{ sandboxId: SandboxId; requester: SlackUserId; turnId: TurnId }> = {},
): Promise<{ token: string; jti: SandboxJwtId }> {
  const { token, identity } = await mintSandboxJwt(
    {
      sandboxId: (overrides.sandboxId ?? 's_test') as SandboxId,
      requester: (overrides.requester ?? 'U_TESTER') as SlackUserId,
      turnId: (overrides.turnId ?? 't_turn_1') as TurnId,
    },
    JWT_CONFIG,
  );
  return { token, jti: identity.jti };
}

/** Build a mock fetch that returns a fake upstream response. */
function makeMockFetch(status = 200, body = '{"ok":true}', headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}

describe('@sym/sandbox — EgressProxy', () => {
  it('injects Authorization header and forwards the request (happy path)', async () => {
    const { token, jti } = await makeToken();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti }));

    const mockFetch = makeMockFetch(200, '{"data":"result"}');
    const db = makeDbStub('real-token-value');

    const auditRecords: unknown[] = [];
    const app = createEgressProxy(store, db, {
      jwt: JWT_CONFIG,
      fetch: mockFetch,
      onAudit: (r) => auditRecords.push(r),
    });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'GET',
        url: 'https://api.github.com/user',
        headers: { 'x-custom': 'value' },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    // Verify fetch was called with injected auth header
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, fetchOptions] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/user');
    const sentHeaders = fetchOptions.headers as Record<string, string>;
    expect(sentHeaders['authorization']).toBe('Bearer real-token-value');
    expect(sentHeaders['x-custom']).toBe('value');

    // Audit was emitted
    expect(auditRecords).toHaveLength(1);
    const audit = auditRecords[0] as Record<string, unknown>;
    expect(audit['provider']).toBe('github');
    expect(audit['status']).toBe(200);
    // No token value in audit
    expect(JSON.stringify(audit)).not.toContain('real-token-value');
  });

  it('strips hop-by-hop headers from the inbound request', async () => {
    const { token, jti } = await makeToken();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti }));

    const mockFetch = makeMockFetch();
    const db = makeDbStub('tok');

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        method: 'GET',
        url: 'https://api.github.com/repos/sym/sym',
        headers: {
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
          'proxy-authorization': 'Basic abc',
          upgrade: 'h2c',
          'x-safe': 'passes-through',
        },
      }),
    });

    await app.fetch(req);

    const [, fetchOptions] = mockFetch.mock.calls[0]!;
    const sentHeaders = fetchOptions.headers as Record<string, string>;

    // Hop-by-hop must be absent
    expect(sentHeaders['connection']).toBeUndefined();
    expect(sentHeaders['keep-alive']).toBeUndefined();
    expect(sentHeaders['transfer-encoding']).toBeUndefined();
    expect(sentHeaders['proxy-authorization']).toBeUndefined();
    expect(sentHeaders['upgrade']).toBeUndefined();

    // Safe header must pass through
    expect(sentHeaders['x-safe']).toBe('passes-through');
  });

  it('returns 403 when no active lease exists', async () => {
    const { token } = await makeToken();

    const store = new LeaseStore(); // empty — no lease
    const db = makeDbStub('tok');
    const mockFetch = makeMockFetch();

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user' }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('egress_denied');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 for a missing Authorization header', async () => {
    const store = new LeaseStore();
    const db = makeDbStub('tok');
    const mockFetch = makeMockFetch();

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user' }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 for an invalid JWT', async () => {
    const store = new LeaseStore();
    const db = makeDbStub('tok');
    const mockFetch = makeMockFetch();

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: 'Bearer this.is.not.a.real.jwt' },
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user' }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toMatch(/invalid/);
  });

  it('returns 401 for an expired JWT', async () => {
    // Mint an already-expired token
    const { token, jti } = await (async () => {
      const { token, identity } = await mintSandboxJwt(
        {
          sandboxId: 's_test' as SandboxId,
          requester: 'U_TESTER' as SlackUserId,
          turnId: 't_turn_1' as TurnId,
        },
        { secret: SECRET, ttlSeconds: -1 }, // expired
      );
      return { token, jti: identity.jti };
    })();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti }));
    const db = makeDbStub('tok');
    const mockFetch = makeMockFetch();

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user' }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('token_expired');
  });

  it('returns 401 for a JWT signed with wrong key', async () => {
    const { token, jti } = await makeToken();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti }));
    const db = makeDbStub('tok');
    const mockFetch = makeMockFetch();

    // Proxy is configured with a DIFFERENT secret
    const app = createEgressProxy(store, db, {
      jwt: { secret: 'wrong-secret-that-does-not-match-the-minter-key!!' },
      fetch: mockFetch,
    });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user' }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it('denies requests to domains not covered by the lease', async () => {
    const { token, jti } = await makeToken();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti, domain: 'api.github.com' }));
    const db = makeDbStub('tok');
    const mockFetch = makeMockFetch();

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        method: 'GET',
        url: 'https://evil.example.com/steal', // different domain
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('egress_denied');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows subdomains of the lease domain', async () => {
    const { token, jti } = await makeToken();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti, domain: 'github.com' }));
    const db = makeDbStub('tok');
    const mockFetch = makeMockFetch();

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        method: 'GET',
        url: 'https://api.github.com/user', // subdomain
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns 403 when the OAuth token is not found in DB', async () => {
    const { token, jti } = await makeToken();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti }));
    const db = makeEmptyDbStub(); // no token row
    const mockFetch = makeMockFetch();

    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG, fetch: mockFetch });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user' }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('health endpoint returns 200', async () => {
    const store = new LeaseStore();
    const db = makeDbStub('tok');
    const app = createEgressProxy(store, db, { jwt: JWT_CONFIG });

    const res = await app.fetch(new Request('http://proxy/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
  });

  it('does not include token values in the audit record', async () => {
    const { token, jti } = await makeToken();

    const store = new LeaseStore();
    store.put(makeLease({ sandboxJwtId: jti }));
    const db = makeDbStub('super-secret-access-token');
    const mockFetch = makeMockFetch();

    const capturedAudits: unknown[] = [];
    const app = createEgressProxy(store, db, {
      jwt: JWT_CONFIG,
      fetch: mockFetch,
      onAudit: (r) => capturedAudits.push(r),
    });

    const req = new Request('http://proxy/proxy', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user' }),
    });

    await app.fetch(req);

    expect(capturedAudits).toHaveLength(1);
    const auditJson = JSON.stringify(capturedAudits[0]);
    expect(auditJson).not.toContain('super-secret-access-token');
  });
});
