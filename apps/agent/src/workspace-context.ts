import { WebApiSlackClient } from './slack-client.js';

import type { AgentConfig } from './config.js';
import type { SlackClient } from '@sym/adapter-slack';
import type { SlackUserId, WorkspaceId } from '@sym/contracts';

/** Everything a turn needs, resolved once from env config (single-tenant). */
export interface WorkspaceContext {
  workspaceId: WorkspaceId;
  botUserId: SlackUserId;
  slackTeamId: string;
  /** The Slack user Sym works for — the owner gate allows only them. */
  ownerSlackUserId: SlackUserId;
  model: string;
  /** Bot-token client — Sym's identity (replies, streaming, status). */
  slackClient: SlackClient;
  /**
   * Owner user-token client — present only when `SLACK_OWNER_USER_TOKEN` is
   * configured. Used by tools declared `actor: 'user'` (broader reads,
   * `search.messages`, future act-as-owner writes).
   */
  userSlackClient?: SlackClient;
  /** Raw Fireworks credentials — consumed by `runLoopPi`. */
  fireworks: {
    baseUrl: string;
    apiKey: string;
  };
}

/**
 * Build the single-tenant runtime context from env config. No DB: there is one
 * workspace, so the Slack team id doubles as the workspace id, and the bot
 * token / owner / model all come straight from env.
 */
export function loadWorkspaceContext(config: AgentConfig): WorkspaceContext {
  const ctx: WorkspaceContext = {
    workspaceId: config.slackTeamId as WorkspaceId,
    botUserId: config.slackBotUserId as SlackUserId,
    slackTeamId: config.slackTeamId,
    ownerSlackUserId: config.ownerSlackUserId as SlackUserId,
    model: config.fireworksModel,
    slackClient: new WebApiSlackClient(config.slackBotToken),
    fireworks: {
      baseUrl: config.fireworksBaseUrl,
      apiKey: config.fireworksApiKey,
    },
  };
  if (config.slackUserToken !== undefined) {
    ctx.userSlackClient = new WebApiSlackClient(config.slackUserToken);
  }
  return ctx;
}

/**
 * Verify both tokens at startup. Logs identity for the bot token (always
 * required) and the user token (when configured). Failures are logged loud
 * but do not throw — the agent still serves bot-only paths if the user
 * token is missing or revoked.
 */
export async function healthCheckTokens(ctx: WorkspaceContext): Promise<void> {
  try {
    const auth = await ctx.slackClient.authTest();
    console.log(`[agent] bot token OK — acting as ${auth.user ?? auth.userId} (${auth.teamId})`);
    if (auth.teamId !== ctx.slackTeamId) {
      console.warn(
        `[agent] bot token team_id ${auth.teamId} does not match SLACK_TEAM_ID ${ctx.slackTeamId}`,
      );
    }
  } catch (err) {
    console.error('[agent] bot token health check FAILED — agent will not function:', err);
  }

  if (ctx.userSlackClient === undefined) {
    console.log(
      '[agent] no SLACK_OWNER_USER_TOKEN configured — actor:user tools will fall back to the bot token where possible',
    );
    return;
  }

  try {
    const auth = await ctx.userSlackClient.authTest();
    console.log(`[agent] user token OK — acting as ${auth.user ?? auth.userId} (${auth.teamId})`);
    if (auth.userId !== ctx.ownerSlackUserId) {
      console.warn(
        `[agent] user token belongs to ${auth.userId}, not the configured SYM_OWNER_SLACK_USER_ID (${ctx.ownerSlackUserId}) — confirm this is intended`,
      );
    }
    if (auth.teamId !== ctx.slackTeamId) {
      console.warn(
        `[agent] user token team_id ${auth.teamId} does not match SLACK_TEAM_ID ${ctx.slackTeamId}`,
      );
    }
  } catch (err) {
    console.error(
      '[agent] user token health check FAILED — actor:user tools will be unavailable. ' +
        'Re-run the OAuth install or update SLACK_OWNER_USER_TOKEN. Error:',
      err,
    );
  }
}
