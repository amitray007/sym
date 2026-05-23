/**
 * LeaseStore unit tests.
 * All hermetic — no network, no DB, no Docker.
 */

import { describe, expect, it } from 'vitest';

import { LeaseStore } from './lease-store.js';

import type {
  GrantId,
  LeaseId,
  LeaseRef,
  OAuthTokenId,
  SandboxJwtId,
  SlackUserId,
} from '@sym/contracts';

function makeLease(overrides: Partial<LeaseRef> = {}): LeaseRef {
  return {
    leaseId: 'lease_1' as LeaseId,
    sandboxJwtId: 'jti_1' as SandboxJwtId,
    provider: 'github',
    domain: 'api.github.com',
    oauthTokenId: 'tok_1' as OAuthTokenId,
    expiresAt: new Date(Date.now() + 60_000), // 1 minute from now
    ...overrides,
  };
}

describe('@sym/sandbox — LeaseStore', () => {
  it('stores and retrieves a lease by sandboxJwtId', () => {
    const store = new LeaseStore();
    const lease = makeLease();
    store.put(lease);
    const found = store.get(lease.sandboxJwtId);
    expect(found).toBeDefined();
    expect(found?.provider).toBe('github');
  });

  it('returns undefined for an unknown jti', () => {
    const store = new LeaseStore();
    expect(store.get('unknown_jti' as SandboxJwtId)).toBeUndefined();
  });

  it('returns undefined and evicts an expired lease', () => {
    const store = new LeaseStore();
    const lease = makeLease({ expiresAt: new Date(Date.now() - 1) }); // expired
    store.put(lease);
    expect(store.get(lease.sandboxJwtId)).toBeUndefined();
    expect(store.size()).toBe(0); // evicted
  });

  it('evictExpired removes all expired leases', () => {
    const store = new LeaseStore();
    store.put(
      makeLease({ sandboxJwtId: 'jti_a' as SandboxJwtId, expiresAt: new Date(Date.now() - 1) }),
    );
    store.put(
      makeLease({ sandboxJwtId: 'jti_b' as SandboxJwtId, expiresAt: new Date(Date.now() - 1) }),
    );
    store.put(
      makeLease({
        sandboxJwtId: 'jti_c' as SandboxJwtId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const evicted = store.evictExpired();
    expect(evicted).toBe(2);
    expect(store.size()).toBe(1);
  });

  it('delete removes a specific lease', () => {
    const store = new LeaseStore();
    const lease = makeLease();
    store.put(lease);
    store.delete(lease.sandboxJwtId);
    expect(store.get(lease.sandboxJwtId)).toBeUndefined();
  });

  it('put overwrites an existing lease for the same jti (idempotent)', () => {
    const store = new LeaseStore();
    const lease1 = makeLease({ provider: 'github' });
    const lease2 = makeLease({ provider: 'sentry' }); // same jti, different provider
    store.put(lease1);
    store.put(lease2);
    expect(store.get(lease1.sandboxJwtId)?.provider).toBe('sentry');
    expect(store.size()).toBe(1);
  });

  it('includes onBehalfOf and grantId when set', () => {
    const store = new LeaseStore();
    const lease = makeLease({
      onBehalfOf: 'U_OTHER' as SlackUserId,
      grantId: 'grant_1' as GrantId,
    });
    store.put(lease);
    const found = store.get(lease.sandboxJwtId);
    expect(found?.onBehalfOf).toBe('U_OTHER');
    expect(found?.grantId).toBe('grant_1');
  });
});
