import { describe, expect, it } from 'vitest';

import { resolveConnectorAuth } from './connector-auth.js';

import type { ConnectorAuth } from './connector-auth.js';
import type { SlackUserId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WS = 'ws_test' as WorkspaceId;
const USER = 'U_alice' as SlackUserId;

/** A single-select row array returned from db.select().from().where().limit() */
type AnyRow = Record<string, unknown>;

/**
 * Build a minimal mock `Database` that returns `firstRows` for the first
 * `.limit()` call and `secondRows` for the second (if any).
 *
 * The mock is chainable and type-cast via `as unknown as Database` — the only
 * contract that matters at runtime is that `limit()` returns a Promise.
 */
function mockDb(firstRows: AnyRow[], secondRows: AnyRow[] = []): Database {
  let callCount = 0;
  const h = {
    insert: () => h,
    values: () => h,
    onConflictDoNothing: () => h,
    select: () => h,
    from: () => h,
    where: () => h,
    orderBy: () => h,
    set: () => h,
    update: () => h,
    limit: () => {
      callCount += 1;
      return Promise.resolve(callCount === 1 ? firstRows : secondRows);
    },
    then: (onF: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(onF, onR),
  };
  return h as unknown as Database;
}

/** A minimal enabled connector row with authMode set. */
function connectorRow(authMode: 'none' | 'static' | 'oauth', extra: Partial<AnyRow> = {}): AnyRow {
  return {
    id: 'cfg_01',
    workspaceId: WS,
    name: 'Test Connector',
    slug: 'my-tool',
    transport: 'http',
    url: 'https://mcp.example.com',
    command: null,
    args: [],
    envJson: null,
    oauthConfigJson: null,
    authMode,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedByAdminId: null,
    ...extra,
  };
}

/** A minimal active oauth token row. */
function tokenRow(extra: Partial<AnyRow> = {}): AnyRow {
  return {
    id: 'tok_01',
    workspaceId: WS,
    slackUserId: USER,
    provider: 'my-tool',
    accessToken: 'tok_live_abc',
    refreshToken: null,
    expiresAt: null,
    scopes: [],
    accountHandle: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
    ...extra,
  };
}

const baseParams = {
  workspaceId: WS,
  slug: 'my-tool',
  requester: USER,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveConnectorAuth', () => {
  describe('unknown / disabled connector', () => {
    it('returns unknown when no enabled connector row exists', async () => {
      const db = mockDb([]); // no connector row
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'unknown' });
    });
  });

  describe('authMode = none', () => {
    it('returns none for an open connector', async () => {
      const db = mockDb([connectorRow('none')]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'none' });
    });
  });

  describe('authMode = static', () => {
    it('returns token with Bearer header when envJson has a token', async () => {
      const row = connectorRow('static', { envJson: JSON.stringify({ token: 'secret_key_42' }) });
      const db = mockDb([row]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'token', authorization: 'Bearer secret_key_42' });
    });

    it('returns needs_auth when envJson has a blank token', async () => {
      const row = connectorRow('static', { envJson: JSON.stringify({ token: '' }) });
      const db = mockDb([row]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'needs_auth' });
    });

    it('returns needs_auth when envJson is missing the token key', async () => {
      const row = connectorRow('static', { envJson: JSON.stringify({ other: 'irrelevant' }) });
      const db = mockDb([row]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'needs_auth' });
    });

    it('returns needs_auth when envJson is null', async () => {
      const row = connectorRow('static', { envJson: null });
      const db = mockDb([row]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'needs_auth' });
    });

    it('returns needs_auth when envJson is malformed JSON', async () => {
      const row = connectorRow('static', { envJson: '{not valid json' });
      const db = mockDb([row]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'needs_auth' });
    });
  });

  describe('authMode = oauth', () => {
    it('returns token with Bearer header for an active non-expiring token', async () => {
      const db = mockDb([connectorRow('oauth')], [tokenRow()]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'token', authorization: 'Bearer tok_live_abc' });
    });

    it('returns token with Bearer header for an active token with future expiresAt', async () => {
      const future = new Date(Date.now() + 60_000);
      const db = mockDb([connectorRow('oauth')], [tokenRow({ expiresAt: future })]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'token', authorization: 'Bearer tok_live_abc' });
    });

    it('returns needs_auth when the oauth token is expired', async () => {
      const past = new Date(Date.now() - 60_000);
      const db = mockDb([connectorRow('oauth')], [tokenRow({ expiresAt: past })]);
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'needs_auth' });
    });

    it('returns needs_auth when no token row exists for the user', async () => {
      const db = mockDb([connectorRow('oauth')], []); // empty second rows
      const result: ConnectorAuth = await resolveConnectorAuth({ ...baseParams, db });
      expect(result).toEqual({ kind: 'needs_auth' });
    });
  });
});
