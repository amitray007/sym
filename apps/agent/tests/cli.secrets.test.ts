/**
 * cli/secrets.ts — unit tests.
 *
 * Uses an in-memory SqliteCredentialStore with a fixed test key so tests are
 * fully isolated and never touch the filesystem or real env vars.
 */

import { describe, expect, it } from 'vitest';

import { SqliteCredentialStore } from '@sym/mcp-runtime';

import { listSecrets, removeSecret, setSecret } from '../src/cli/secrets.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** 32 bytes filled with 0x07, base64-encoded — deterministic, never a real key. */
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function makeStore(): SqliteCredentialStore {
  return new SqliteCredentialStore(':memory:', TEST_KEY);
}

// ---------------------------------------------------------------------------
// setSecret / listSecrets
// ---------------------------------------------------------------------------

describe('setSecret + listSecrets', () => {
  it('setSecret stores a secret and listSecrets returns its ref', () => {
    const store = makeStore();

    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'tok', store);

    const refs = listSecrets(store);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ connector: 'sentry', field: 'SENTRY_AUTH_TOKEN' });
  });

  it('field name in listSecrets has NO "secret:" prefix', () => {
    const store = makeStore();

    setSecret('github', 'GH_TOKEN', 'ghp_abc', store);

    const refs = listSecrets(store);
    expect(refs).toHaveLength(1);
    // The raw DB stores the field as "secret:GH_TOKEN" but listSecretRefs strips the prefix.
    expect(refs[0]?.field).toBe('GH_TOKEN');
    expect(refs[0]?.field).not.toContain('secret:');
  });

  it('getSecret round-trips the plaintext value (encrypted at rest)', () => {
    const store = makeStore();

    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'tok', store);

    // getSecret decrypts and returns the original value.
    expect(store.getSecret('sentry', 'SENTRY_AUTH_TOKEN')).toBe('tok');
  });

  it('multiple connectors each appear in listSecrets', () => {
    const store = makeStore();

    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'tok-sentry', store);
    setSecret('datadog', 'DD_API_KEY', 'tok-dd', store);

    const refs = listSecrets(store);
    expect(refs).toHaveLength(2);

    const connectors = refs.map((r) => r.connector);
    expect(connectors).toContain('sentry');
    expect(connectors).toContain('datadog');
  });

  it('overwriting a secret keeps listSecrets length stable', () => {
    const store = makeStore();

    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'v1', store);
    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'v2', store);

    const refs = listSecrets(store);
    expect(refs).toHaveLength(1);
    expect(store.getSecret('sentry', 'SENTRY_AUTH_TOKEN')).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// removeSecret
// ---------------------------------------------------------------------------

describe('removeSecret', () => {
  it('removeSecret deletes the secret and listSecrets no longer contains it', () => {
    const store = makeStore();

    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'tok', store);
    expect(listSecrets(store)).toHaveLength(1);

    removeSecret('sentry', 'SENTRY_AUTH_TOKEN', store);

    const refs = listSecrets(store);
    expect(refs).toHaveLength(0);
    expect(refs.find((r) => r.connector === 'sentry')).toBeUndefined();
  });

  it('removeSecret on a non-existent key is a no-op', () => {
    const store = makeStore();

    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'tok', store);

    // Remove something that doesn't exist — should not throw.
    removeSecret('sentry', 'NONEXISTENT_FIELD', store);

    // Original secret still there.
    expect(listSecrets(store)).toHaveLength(1);
  });

  it('removing one secret does not affect another connector', () => {
    const store = makeStore();

    setSecret('sentry', 'SENTRY_AUTH_TOKEN', 'tok-sentry', store);
    setSecret('datadog', 'DD_API_KEY', 'tok-dd', store);

    removeSecret('sentry', 'SENTRY_AUTH_TOKEN', store);

    const refs = listSecrets(store);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ connector: 'datadog', field: 'DD_API_KEY' });
  });
});

// ---------------------------------------------------------------------------
// Missing key guard (openStore path)
// ---------------------------------------------------------------------------

describe('openStore — missing SYM_ENCRYPTION_KEY', () => {
  it('setSecret without a store and no SYM_ENCRYPTION_KEY throws a user-friendly error', () => {
    const saved = process.env['SYM_ENCRYPTION_KEY'];
    delete process.env['SYM_ENCRYPTION_KEY'];

    try {
      expect(() => setSecret('x', 'y', 'z')).toThrow(/sym secret/);
    } finally {
      // Restore to avoid polluting sibling tests.
      if (saved !== undefined) {
        process.env['SYM_ENCRYPTION_KEY'] = saved;
      }
    }
  });
});
