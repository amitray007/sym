import { eq } from 'drizzle-orm';

import { loadDatabaseUrl } from './cli-env.js';
import { createDb } from './client.js';
import { aclModes, dashboardAdmins, workspaces } from './schema/index.js';

/**
 * Round-trip smoke: reads the seeded workspace(s) back through Drizzle and
 * prints a summary. This is the observable proof of the Sp2 end goal.
 */
async function main(): Promise<void> {
  const { db, close } = createDb(loadDatabaseUrl(), { max: 1 });

  const allWorkspaces = await db.select().from(workspaces);
  console.info(`[db:check] workspaces: ${allWorkspaces.length}`);

  for (const w of allWorkspaces) {
    const admins = await db
      .select()
      .from(dashboardAdmins)
      .where(eq(dashboardAdmins.workspaceId, w.id));
    const modes = await db.select().from(aclModes).where(eq(aclModes.workspaceId, w.id));
    console.info(
      `  • ${w.name} (${w.slackTeamId}) id=${w.id} status=${w.status} ` +
        `admins=${admins.length} aclModes=${modes.length}`,
    );
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
