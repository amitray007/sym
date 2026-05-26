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
  slackClient: SlackClient;
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
  return {
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
}
