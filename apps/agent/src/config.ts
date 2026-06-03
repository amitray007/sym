/**
 * Agent runtime config — read entirely from injected env (Dokploy in prod; `.env`
 * in dev via the entrypoint's dotenv load). Single-tenant: one Slack workspace,
 * one owner, one model provider. No secrets are logged.
 */

import { z } from 'zod';

import { loadConnectorConfigs } from '@sym/mcp-runtime';

import type { ConnectorConfig, ConfigSource } from '@sym/mcp-runtime';
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
  /**
   * When true, `post_as_owner` appends a small `_(via Sym)_` footer to the
   * posted message so collaborators know the owner used an assistant to
   * relay it. Defaults to true for transparency; set to false to suppress.
   */
  ownerPostMarker: boolean;
  /**
   * When true, the agent asks the owner to confirm `run_cli` calls before
   * executing — except help/version introspection (`--help`, `--version`,
   * bare binary), which remain unconfirmed so the agent can learn a CLI
   * without prompting. Defaults to false (full freedom within the allowlist).
   * Optional so existing callers that don't set it yet default to false.
   */
  cliConfirm?: boolean;
  /**
   * Per-turn deadline in milliseconds. A stuck model or a Fireworks error-loop
   * is aborted after this many ms, producing a partial/timed-out reply instead
   * of consuming credits without bound.
   * Default: 60 000 (60 s). Set to 0 to disable.
   * Optional so existing callers that don't set it yet use the default.
   */
  turnDeadlineMs?: number;
  /**
   * Maximum number of threaded history messages fed to the model per turn.
   * The most-recent N messages are kept (tail-slice). A 200-reply thread would
   * otherwise send all 200 messages to the model on every turn, growing cost
   * linearly with thread length.
   * Default: 80. Set to 0 to disable the cap (send all messages).
   * Optional so existing callers that don't set it yet use the default.
   */
  threadHistoryLimit?: number;
}

export interface AgentConfig {
  port: number;
  /** App-level Slack signing secret (verifies inbound event signatures). */
  slackSigningSecret: string;
  /** Bot token (`xoxb-…`) for all outbound Slack Web API calls. */
  slackBotToken: string;
  /**
   * Owner user token (`xoxp-…`) — optional. When set, tools declared
   * `actor: 'user'` use it (broader reads, real `search.messages`,
   * act-as-owner writes). When absent, read tools fall back to the bot
   * token; user-required tools (act-as-owner writes) become unavailable.
   */
  slackUserToken?: string;
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
  /**
   * MCP connector configs — loaded from the config file (`SYM_CONFIG_PATH`,
   * default `.sym/config.json`) when present, else the legacy `SYM_MCP_SERVERS`
   * env var. Empty array when neither is configured — no MCP tools, no crash.
   */
  mcpServers: ConnectorConfig[];
  /** Where `mcpServers` was loaded from — for boot-log diagnostics. */
  mcpConfigSource: ConfigSource;
}

const DEFAULT_FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
const DEFAULT_TASK_CARD_THRESHOLD = 1;
const DEFAULT_TURN_DEADLINE_MS = 60_000;
const DEFAULT_THREAD_HISTORY_LIMIT = 80;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Zod schema for the behavior-knob env vars.
 *
 * Non-negative integer knobs use `z.coerce.number().int().nonnegative()` with
 * `.catch(default)` so a typo'd/missing value silently falls back to the safe
 * default (same NaN-safe semantics as the old `posIntEnv` helper, but
 * declarative). `0` is a valid value — callers treat it as "no limit".
 */
const behaviorEnvSchema = z.object({
  TASK_CARD_THRESHOLD: z.coerce.number().int().nonnegative().catch(DEFAULT_TASK_CARD_THRESHOLD),
  TASK_CARD_AFTER: z.enum(['collapse', 'delete']).catch('delete'),
  OWNER_POST_MARKER: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  SYM_CLI_CONFIRM: z
    .string()
    .optional()
    .transform((v) => /^(1|true|yes|on)$/i.test(v ?? '')),
  SYM_TURN_DEADLINE_MS: z.coerce.number().int().nonnegative().catch(DEFAULT_TURN_DEADLINE_MS),
  SYM_THREAD_HISTORY_LIMIT: z.coerce
    .number()
    .int()
    .nonnegative()
    .catch(DEFAULT_THREAD_HISTORY_LIMIT),
});

export function loadAgentConfig(): AgentConfig {
  const connectors = loadConnectorConfigs();
  const behavior = behaviorEnvSchema.parse(process.env);
  return {
    port: Number(process.env['AGENT_PORT'] ?? '3001'),
    slackSigningSecret: required('SLACK_SIGNING_SECRET'),
    slackBotToken: required('SLACK_BOT_TOKEN'),
    ...(process.env['SLACK_OWNER_USER_TOKEN']
      ? { slackUserToken: process.env['SLACK_OWNER_USER_TOKEN'] }
      : {}),
    slackBotUserId: required('SLACK_BOT_USER_ID'),
    slackTeamId: required('SLACK_TEAM_ID'),
    ownerSlackUserId: required('SYM_OWNER_SLACK_USER_ID'),
    fireworksApiKey: required('FIREWORKS_API_KEY'),
    fireworksModel: required('FIREWORKS_MODEL'),
    fireworksBaseUrl: process.env['FIREWORKS_BASE_URL'] ?? DEFAULT_FIREWORKS_BASE_URL,
    behavior: {
      taskCardThreshold: behavior.TASK_CARD_THRESHOLD,
      taskCardAfter: behavior.TASK_CARD_AFTER,
      ownerPostMarker: behavior.OWNER_POST_MARKER,
      cliConfirm: behavior.SYM_CLI_CONFIRM,
      turnDeadlineMs: behavior.SYM_TURN_DEADLINE_MS,
      threadHistoryLimit: behavior.SYM_THREAD_HISTORY_LIMIT,
    },
    mcpServers: connectors.mcpServers,
    mcpConfigSource: connectors.source,
  };
}
