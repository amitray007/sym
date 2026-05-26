import { initSecrets } from '@sym/secrets';
import { eq } from 'drizzle-orm';

import { loadDatabaseUrl } from './cli-env.js';
import { createDb } from './client.js';
import { dashboardAdmins, slackInstalls, workspaces } from './schema/index.js';

const TEST_TEAM_ID = 'T_SYM_DEV';

/**
 * Inserts a single dev workspace with an owner admin and a (fake) Slack install.
 * Idempotent — safe to run repeatedly. The Slack bot token is encrypted via
 * `encryptedText`, so we init the key ring first.
 */
async function main(): Promise<void> {
  const databaseUrl = loadDatabaseUrl();
  await initSecrets();
  const { db, close } = createDb(databaseUrl, { max: 1 });

  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slackTeamId, TEST_TEAM_ID))
    .limit(1);

  let workspaceId = existing[0]?.id;

  if (!workspaceId) {
    const inserted = await db
      .insert(workspaces)
      .values({
        slackTeamId: TEST_TEAM_ID,
        name: 'Sym Dev Workspace',
        timezone: 'America/Los_Angeles',
      })
      .returning({ id: workspaces.id });
    workspaceId = inserted[0]?.id;
    if (!workspaceId) {
      throw new Error('[db:seed] failed to insert workspace');
    }
    console.info('[db:seed] inserted workspace', workspaceId);
  } else {
    console.info('[db:seed] workspace already present', workspaceId);
  }

  await db
    .insert(dashboardAdmins)
    .values({
      workspaceId,
      clerkUserId: 'user_dev_owner',
      email: 'dev-owner@example.com',
      role: 'owner',
    })
    .onConflictDoNothing();

  await db
    .insert(slackInstalls)
    .values({
      workspaceId,
      botUserId: 'U_SYM_BOT',
      appId: 'A_SYM',
      botAccessToken: 'xoxb-dev-fake-token',
      scopes: ['app_mentions:read', 'chat:write', 'im:history'],
      installedBySlackUserId: 'U_DEV_OWNER',
    })
    .onConflictDoNothing();

  console.info('[db:seed] done.');
  await close();
}

main().catch((err: unknown) => {
  console.error('[db:seed] failed:', err);
  process.exit(1);
});
