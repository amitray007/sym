import { WebApiSlackClient } from './slack-client.js';

import type { AgentConfig } from './config.js';
import type { SlackClient } from '@sym/adapter-slack';
import type { SlackUserId, WorkspaceId } from '@sym/contracts';
import type { OwnerIdentity } from '@sym/kernel';

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
  /**
   * Owner identity (name, tz, title) — resolved once at boot via users.info.
   * Threaded into every turn's metadata so the model can address the owner
   * by name and reason about their timezone. Mutated in place by
   * `healthCheckTokens` once the lookup completes; turns that arrive before
   * resolution simply omit the owner block.
   */
  ownerProfile?: OwnerIdentity;
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
  } else {
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

  // Resolve owner profile so we can inject "owner: Amit Ray …" into every
  // turn's metadata. Prefer the user token (richer fields), fall back to bot.
  // Mutates ctx in place; turns that arrive before this resolves simply omit
  // the owner block — the system prompt rule handles graceful degradation.
  const profileClient = ctx.userSlackClient ?? ctx.slackClient;
  try {
    const profile = await profileClient.usersInfo({ user: ctx.ownerSlackUserId });
    ctx.ownerProfile = {
      userId: ctx.ownerSlackUserId,
      ...(profile.userName !== undefined && profile.userName.length > 0
        ? { userName: profile.userName }
        : {}),
      ...(profile.displayName !== undefined && profile.displayName.length > 0
        ? { displayName: profile.displayName }
        : {}),
      ...(profile.realName !== undefined && profile.realName.length > 0
        ? { realName: profile.realName }
        : {}),
      ...(profile.title !== undefined && profile.title.length > 0 ? { title: profile.title } : {}),
      ...(profile.tz !== undefined ? { tz: profile.tz } : {}),
    };
    const label = ctx.ownerProfile.displayName ?? ctx.ownerProfile.realName ?? ctx.ownerSlackUserId;
    const handle = ctx.ownerProfile.userName ? `@${ctx.ownerProfile.userName}` : '(no @handle)';
    const tz = ctx.ownerProfile.tz ?? 'unknown tz';
    console.log(`[agent] owner profile resolved — ${label} ${handle} (${tz})`);
  } catch (err) {
    console.warn(
      '[agent] could not resolve owner profile — turn metadata will fall back to raw user id. Error:',
      err,
    );
  }
}
