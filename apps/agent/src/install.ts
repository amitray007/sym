import { slackInstalls, uuidv7, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';

import type { SlackOAuthResult } from './slack-oauth.js';
import type { Database } from '@sym/db';

/** Thrown when a second, different Slack team tries to install (single-tenant). */
export class SingleTenantError extends Error {
  constructor(existingTeamId: string, attemptedTeamId: string) {
    super(
      `This Sym install is bound to Slack team ${existingTeamId}; ` +
        `refusing to install for a different team ${attemptedTeamId}. ` +
        `Single-tenant: one install = one workspace.`,
    );
    this.name = 'SingleTenantError';
  }
}

export interface InstallResult {
  workspaceId: string;
  teamId: string;
  /** True when this re-authorized an existing workspace (vs. a first install). */
  reinstalled: boolean;
}

/**
 * Persist a Slack install. Single-tenant: there is at most one workspace.
 *  - First install → insert workspaces + slack_installs.
 *  - Same team re-auth → reuse the workspace, revoke the old active install,
 *    insert a fresh active one (honors the one-active-install-per-workspace
 *    partial unique).
 *  - Different team → throw SingleTenantError.
 *
 * The bot token is written to the `encryptedText` column, so `initSecrets()`
 * must have run at boot. Runs in one transaction (D-DB-1).
 */
export async function installWorkspace(
  db: Database,
  result: SlackOAuthResult,
): Promise<InstallResult> {
  return db.transaction(async (tx) => {
    const existing = (await tx.select().from(workspaces).limit(1))[0];

    if (existing && existing.slackTeamId !== result.teamId) {
      throw new SingleTenantError(existing.slackTeamId, result.teamId);
    }

    let workspaceId: string;
    const reinstalled = Boolean(existing);

    if (existing) {
      workspaceId = existing.id;
      await tx
        .update(workspaces)
        .set({ name: result.teamName, updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
    } else {
      workspaceId = uuidv7();
      await tx.insert(workspaces).values({
        id: workspaceId,
        slackTeamId: result.teamId,
        name: result.teamName,
        // The first installer is the owner. Captured once here and never
        // overwritten on re-auth — a re-install (even by a different user) must
        // not silently hand over ownership of a single-owner Sym.
        ownerSlackUserId: result.installerUserId,
      });
    }

    // Revoke any currently-active install so the partial-unique
    // (one active per workspace) holds when we insert the new one.
    await tx
      .update(slackInstalls)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(slackInstalls.workspaceId, workspaceId), eq(slackInstalls.status, 'active')));

    await tx.insert(slackInstalls).values({
      id: uuidv7(),
      workspaceId,
      botUserId: result.botUserId,
      appId: result.appId,
      botAccessToken: result.accessToken, // encryptedText → encrypted on write
      scopes: result.scope ? result.scope.split(',').filter(Boolean) : [],
      installedBySlackUserId: result.installerUserId,
      ...(result.enterpriseId ? { enterpriseId: result.enterpriseId } : {}),
      status: 'active',
    });

    return { workspaceId, teamId: result.teamId, reinstalled };
  });
}
