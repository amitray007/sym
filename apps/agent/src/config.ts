/**
 * Agent runtime config — read entirely from injected env (Dokploy in prod; `.env`
 * in dev via the entrypoint's dotenv load). Single-tenant: one Slack workspace,
 * one owner, one model provider. No secrets are logged.
 */
/** Runtime behavior knobs — all optional, all have safe defaults. */
export interface BehaviorConfig {
  /**
   * Minimum tool calls before the live task card appears on normal queries
   * (app_mention / dm). Slash commands always show from tool #1.
   * Default: 1 — task chunks render inside the streaming reply, so showing
   * them from the first tool has no clutter cost. Set to 0 to disable.
   */
  taskCardThreshold: number;
  /**
   * What happens to the task card after the reply is delivered.
   *   delete   — card is removed (default, keeps thread clean)
   *   collapse — card shrinks to a single "✅ N steps · Xs" summary line
   */
  taskCardAfter: 'delete' | 'collapse';
}

export interface AgentConfig {
  port: number;
  /** App-level Slack signing secret (verifies inbound event signatures). */
  slackSigningSecret: string;
  /** Bot token (`xoxb-…`) for all outbound Slack Web API calls. */
  slackBotToken: string;
  /** Sym's own bot user id (`U…`) — marks its own posts + ignores its own events. */
  slackBotUserId: string;
  /** The Slack workspace (team) id Sym serves; events from other teams are ignored. */
  slackTeamId: string;
  /** The single Slack user Sym works for — the owner gate allows only them. */
  ownerSlackUserId: string;
  /** Fireworks (OpenAI-compatible) API key. */
  fireworksApiKey: string;
  /** Fireworks model id, e.g. `accounts/fireworks/models/…`. */
  fireworksModel: string;
  /** Fireworks base URL (defaults to the public inference endpoint). */
  fireworksBaseUrl: string;
  /** Runtime behavior toggles. */
  behavior: BehaviorConfig;
}

const DEFAULT_FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
const DEFAULT_TASK_CARD_THRESHOLD = 1;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function taskCardAfter(raw: string | undefined): 'delete' | 'collapse' {
  if (raw === 'collapse') return 'collapse';
  return 'delete';
}

export function loadAgentConfig(): AgentConfig {
  return {
    port: Number(process.env['AGENT_PORT'] ?? '3001'),
    slackSigningSecret: required('SLACK_SIGNING_SECRET'),
    slackBotToken: required('SLACK_BOT_TOKEN'),
    slackBotUserId: required('SLACK_BOT_USER_ID'),
    slackTeamId: required('SLACK_TEAM_ID'),
    ownerSlackUserId: required('SYM_OWNER_SLACK_USER_ID'),
    fireworksApiKey: required('FIREWORKS_API_KEY'),
    fireworksModel: required('FIREWORKS_MODEL'),
    fireworksBaseUrl: process.env['FIREWORKS_BASE_URL'] ?? DEFAULT_FIREWORKS_BASE_URL,
    behavior: {
      taskCardThreshold: Number(process.env['TASK_CARD_THRESHOLD'] ?? DEFAULT_TASK_CARD_THRESHOLD),
      taskCardAfter: taskCardAfter(process.env['TASK_CARD_AFTER']),
    },
  };
}
