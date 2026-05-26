import { initSecrets } from '@sym/secrets';
import { eq } from 'drizzle-orm';

import { loadDatabaseUrl } from './cli-env.js';
import { createDb } from './client.js';
import { dashboardAdmins, slackInstalls, workspaces } from './schema/index.js';

/** Mask a secret for display: keep a recognizable head + tail, hide the middle. */
function mask(secret: string): string {
  if (secret.length <= 12) return '••••';
  return `${secret.slice(0, 6)}…${secret.slice(-4)} (${secret.length} chars)`;
}

/**
 * Round-trip smoke: reads the seeded workspace(s) back through Drizzle and
 * prints a summary. Also reads the Slack install's bot token — proving the
 * `encryptedText` column decrypts transparently. Observable proof of Sp2+Sp4.
 */
async function main(): Promise<void> {
  const databaseUrl = loadDatabaseUrl();
  await initSecrets();
  const { db, close } = createDb(databaseUrl, { max: 1 });

  const allWorkspaces = await db.select().from(workspaces);
  console.info(`[db:check] workspaces: ${allWorkspaces.length}`);

  for (const w of allWorkspaces) {
    const admins = await db
      .select()
      .from(dashboardAdmins)
      .where(eq(dashboardAdmins.workspaceId, w.id));
    const installs = await db
      .select()
      .from(slackInstalls)
      .where(eq(slackInstalls.workspaceId, w.id));
    console.info(
      `  • ${w.name} (${w.slackTeamId}) id=${w.id} status=${w.status} ` +
        `owner=${w.ownerSlackUserId ?? '(unset)'} admins=${admins.length}`,
    );
    for (const install of installs) {
      // botAccessToken is decrypted by encryptedText.fromDriver on read.
      console.info(`    ↳ slack_install bot token (decrypted): ${mask(install.botAccessToken)}`);
    }
  }

  if (allWorkspaces.length === 0) {
    console.warn('[db:check] no workspaces found — run `pnpm db:seed` first.');
  }

  console.info('[db:check] round-trip OK.');
  await close();
}

main().catch((err: unknown) => {
  console.error('[db:check] failed:', err);
  process.exit(1);
});
