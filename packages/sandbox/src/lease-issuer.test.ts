/**
 * LeaseIssuer unit tests — DB is mocked, no real Postgres required.
 * DB-touching integration tests are gated behind DATABASE_URL.
 */

import { describe, expect, it, vi } from 'vitest';

import { LeaseIssuer } from './lease-issuer.js';
import { LeaseStore } from './lease-store.js';

import type { IssueLeaseParams } from './lease-issuer.js';
import type { GrantId, OAuthTokenId, SandboxJwtId, SlackUserId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

/** Minimal DB stub for issue() — just tracks calls. */
function makeDbStub(shouldFail = false): Database {
  const insertResult = shouldFail
    ? { values: () => Promise.reject(new Error('DB write failed')) }
    : { values: () => Promise.resolve() };

  const selectResult = {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([]),
      }),
    }),
  };

  return {
    insert: vi.fn(() => insertResult),
    select: vi.fn(() => selectResult),
  } as unknown as Database;
}

const BASE_PARAMS: IssueLeaseParams = {
  workspaceId: 'ws_1' as WorkspaceId,
  turnId: 't_turn_1',
  sandboxJwtId: 'jti_test' as SandboxJwtId,
  requester: 'U_TESTER' as SlackUserId,
  provider: 'github',
  domain: 'api.github.com',
  oauthTokenId: 'tok_1' as OAuthTokenId,
};

describe('@sym/sandbox — LeaseIssuer', () => {
  it('issues a lease and puts it in the hot store', async () => {
    const db = makeDbStub();
    const store = new LeaseStore();
    const issuer = new LeaseIssuer(db, store);

    const result = await issuer.issue(BASE_PARAMS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lease.provider).toBe('github');
    expect(result.lease.domain).toBe('api.github.com');
    expect(result.lease.sandboxJwtId).toBe(BASE_PARAMS.sandboxJwtId);
    expect(result.lease.oauthTokenId).toBe(BASE_PARAMS.oauthTokenId);
    expect(result.lease.expiresAt).toBeInstanceOf(Date);
    expect(result.lease.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Hot store must have it
    const fromStore = store.get(BASE_PARAMS.sandboxJwtId);
    expect(fromStore).toBeDefined();
    expect(fromStore?.provider).toBe('github');
  });

  it('uses the custom TTL if provided', async () => {
    const db = makeDbStub();
    const store = new LeaseStore();
    const issuer = new LeaseIssuer(db, store);

    const ttlMs = 5000;
    const before = Date.now();
    const result = await issuer.issue({ ...BASE_PARAMS, ttlMs });
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exp = result.lease.expiresAt.getTime();
    expect(exp).toBeGreaterThanOrEqual(before + ttlMs - 100);
    expect(exp).toBeLessThanOrEqual(after + ttlMs + 100);
  });

  it('returns an error result when DB write fails', async () => {
    const db = makeDbStub(true);
    const store = new LeaseStore();
    const issuer = new LeaseIssuer(db, store);

    const result = await issuer.issue(BASE_PARAMS);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.domain).toBe('sandbox');
    expect(result.error.code).toBe('spawn_failed');
    // Hot store must NOT have an entry (DB failed)
    expect(store.get(BASE_PARAMS.sandboxJwtId)).toBeUndefined();
  });

  it('includes onBehalfOf and grantId in the lease when provided', async () => {
    const db = makeDbStub();
    const store = new LeaseStore();
    const issuer = new LeaseIssuer(db, store);

    const result = await issuer.issue({
      ...BASE_PARAMS,
      onBehalfOf: 'U_GRANTOR' as SlackUserId,
      grantId: 'grant_xyz' as GrantId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lease.onBehalfOf).toBe('U_GRANTOR');
    expect(result.lease.grantId).toBe('grant_xyz');
  });

  it('load() returns undefined when DB has no row', async () => {
    const db = makeDbStub();
    const store = new LeaseStore();
    const issuer = new LeaseIssuer(db, store);

    const found = await issuer.load('nonexistent_jti' as SandboxJwtId);
    expect(found).toBeUndefined();
  });
});
