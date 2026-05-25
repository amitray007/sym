import { providerConfigs, slackInstalls, workspaces } from '@sym/db';
import { FireworksProvider } from '@sym/provider-fireworks';
import { and, eq } from 'drizzle-orm';

import { WebApiSlackClient } from './slack-client.js';

import type { SlackClient } from '@sym/adapter-slack';
import type { ProviderInterface, SlackUserId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

const DEFAULT_FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

/** Everything a turn needs, resolved from the workspace's DB config. */
export interface WorkspaceContext {
  workspaceId: WorkspaceId;
  botUserId: SlackUserId;
  slackTeamId: string;
  /**
   * The Slack user Sym works for. Null only if an install predates the owner
   * backfill — the owner gate treats null as "deny everyone" (fail closed).
   */
  ownerSlackUserId: SlackUserId | null;
  provider: ProviderInterface;
  model: string;
  slackClient: SlackClient;
}

/**
 * Resolve the runtime context for a Slack team: the workspace row, its active
 * bot install (token), and its active provider config. Encrypted columns
 * (`bot_access_token`, `api_key`) decrypt transparently on read — `initSecrets()`
 * must have run at boot. Returns `null` when the workspace isn't installed or
 * configured (the agent then silently skips the turn).
 */
export async function loadWorkspaceContext(
  db: Database,
  slackTeamId: string,
): Promise<WorkspaceContext | null> {
  const workspace = (
    await db.select().from(workspaces).where(eq(workspaces.slackTeamId, slackTeamId)).limit(1)
  )[0];
  if (!workspace) return null;

  const install = (
    await db
      .select()
      .from(slackInstalls)
      .where(and(eq(slackInstalls.workspaceId, workspace.id), eq(slackInstalls.status, 'active')))
      .limit(1)
  )[0];
  if (!install) return null;

  const config = (
    await db
      .select()
      .from(providerConfigs)
      .where(and(eq(providerConfigs.workspaceId, workspace.id), eq(providerConfigs.enabled, true)))
      .limit(1)
  )[0];
  if (!config) return null;

  const provider = new FireworksProvider({
    baseUrl: config.baseUrl ?? DEFAULT_FIREWORKS_BASE_URL,
    apiKey: config.apiKey,
  });

  return {
    workspaceId: workspace.id as WorkspaceId,
    botUserId: install.botUserId as SlackUserId,
    slackTeamId: workspace.slackTeamId,
    ownerSlackUserId: workspace.ownerSlackUserId as SlackUserId | null,
    provider,
    model: config.modelChat,
    slackClient: new WebApiSlackClient(install.botAccessToken),
  };
}
