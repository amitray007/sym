import { auditEvents, createDb, slackInstalls, workspaces } from '@sym/db';
import { initSecrets } from '@sym/secrets';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SingleTenantError, installWorkspace } from './install.js';

import type { SlackOAuthResult } from './slack-oauth.js';
import type { Database } from '@sym/db';

// DB-gated. Single-tenant means one workspace, so this suite OWNS the workspace
// table: it clears it on entry and exit. Re-run `pnpm db:seed` afterward to
// restore the dev fixture.
const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl ? describe : describe.skip;

function makeResult(over: Partial<SlackOAuthResult> = {}): SlackOAuthResult {
  return {
    accessToken: 'xoxb-test-token',
    botUserId: 'UBOT',
    appId: 'A123',
    scope: 'chat:write,app_mentions:read',
    teamId: 'T_INSTALL_TEST',
    teamName: 'Install Test',
    installerUserId: 'UADMIN',
    ...over,
  };
}

async function clearAll(db: Database): Promise<void> {
  await db.delete(auditEvents); // RESTRICT FK → clear before workspaces
  await db.delete(slackInstalls);
  await db.delete(workspaces);
}

suite('@sym/agent installWorkspace (integration)', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const handle = createDb(databaseUrl ?? '', { max: 1 });
    db = handle.db;
    close = handle.close;
    await initSecrets(); // bot token is an encryptedText column
    await clearAll(db);
  });

  afterAll(async () => {
    await clearAll(db);
    await close();
  });

  it('first install writes a workspace + active install (token encrypted at rest, decrypts on read)', async () => {
    const r = await installWorkspace(db, makeResult());
    expect(r.reinstalled).toBe(false);
    expect(r.teamId).toBe('T_INSTALL_TEST');

    const rows = await db
      .select()
      .from(slackInstalls)
      .where(eq(slackInstalls.workspaceId, r.workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.botAccessToken).toBe('xoxb-test-token'); // decrypted via encryptedText
  });

  it('re-auth of the same team revokes the old install and adds a new active one', async () => {
    const r = await installWorkspace(db, makeResult({ accessToken: 'xoxb-rotated-token' }));
    expect(r.reinstalled).toBe(true);

    const active = await db
      .select()
      .from(slackInstalls)
      .where(and(eq(slackInstalls.workspaceId, r.workspaceId), eq(slackInstalls.status, 'active')));
    expect(active).toHaveLength(1);
    expect(active[0]?.botAccessToken).toBe('xoxb-rotated-token');
  });

  it('refuses a different team (single-tenant)', async () => {
    await expect(
      installWorkspace(db, makeResult({ teamId: 'T_OTHER', teamName: 'Other Co' })),
    ).rejects.toBeInstanceOf(SingleTenantError);
  });
});
