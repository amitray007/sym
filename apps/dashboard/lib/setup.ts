/**
 * First-run setup status (single-tenant). "Complete" = an active Slack install
 * plus an enabled provider config — the minimum for Sym to function.
 */

import { providerConfigs, slackInstalls, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';

import { getDb } from './db';

export interface SetupStatus {
  hasWorkspace: boolean;
  hasInstall: boolean;
  hasProvider: boolean;
  complete: boolean;
}

const EMPTY: SetupStatus = {
  hasWorkspace: false,
  hasInstall: false,
  hasProvider: false,
  complete: false,
};

export async function getSetupStatus(): Promise<SetupStatus> {
  const handle = getDb();
  if (!handle) return EMPTY;
  const { db } = handle;

  const ws = (await db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];
  if (!ws) return EMPTY;

  const [install, provider] = await Promise.all([
    db
      .select({ id: slackInstalls.id })
      .from(slackInstalls)
      .where(and(eq(slackInstalls.workspaceId, ws.id), eq(slackInstalls.status, 'active')))
      .limit(1),
    db
      .select({ id: providerConfigs.id })
      .from(providerConfigs)
      .where(and(eq(providerConfigs.workspaceId, ws.id), eq(providerConfigs.enabled, true)))
      .limit(1),
  ]);

  const hasInstall = install.length > 0;
  const hasProvider = provider.length > 0;
  return {
    hasWorkspace: true,
    hasInstall,
    hasProvider,
    complete: hasInstall && hasProvider,
  };
}
