/**
 * Agent runtime config — read entirely from injected env (Dokploy in prod; `.env`
 * in dev via the entrypoint's dotenv load). Single-tenant: one Slack workspace,
 * one owner, one model provider. No secrets are logged.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { repoAllowlistSchema } from '@sym/cursor-runtime';
import { resolvePersona } from '@sym/kernel';
import { loadConnectorConfigs } from '@sym/mcp-runtime';

import type { RepoAllowlist } from '@sym/cursor-runtime';
import type { PersonaName } from '@sym/kernel';
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
   * of consuming credits without bound. Sym also runs as a debugger bot, where
   * a single turn can legitimately run for many minutes (long builds, test
   * suites, multi-step investigation), so the default is generous.
   * Default: 1 800 000 (30 min). Set to 0 to disable.
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
  /**
   * Home / default persona voice for this deployment (`SYM_PERSONA`). This is the
   * turn's active voice unless a per-channel override or an explicit ask changes
   * it (e.g. an enterprise deploy homes to `concierge`).
   * Default: `'sym'`. Optional so existing callers that don't set it use the default.
   */
  persona?: PersonaName;
  /**
   * When true (default), `dispatch_cloud_agent` is confirmation-gated — the
   * owner previews the repo + task in Slack before the cloud run fires. Set
   * `SYM_CLOUD_AGENT_CONFIRM=false` to dispatch without the prompt. Defaults to
   * true: the task text is model-generated and may follow content read during
   * the turn, so the preview is the owner's review of what gets dispatched.
   */
  cloudAgentConfirm?: boolean;
}

/** Cursor cloud-agent config — present only when CURSOR_API_KEY is set (opt-in). */
export interface CursorConfig {
  apiKey: string;
  model: string;
  repoAllowlist: RepoAllowlist;
  pollIntervalMs?: number;
  dbPath?: string;
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
  /**
   * Cursor cloud-agent config — set only when a non-empty `CURSOR_API_KEY` is
   * configured. Undefined disables the feature entirely (the tool isn't
   * registered and no reconciler starts) — zero behavior change.
   */
  cursor?: CursorConfig;
}

const DEFAULT_FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
const DEFAULT_TASK_CARD_THRESHOLD = 1;
const DEFAULT_TURN_DEADLINE_MS = 1_800_000;
const DEFAULT_THREAD_HISTORY_LIMIT = 80;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Load the cloud-agent repo allowlist from the same `.sym/config.json` the MCP
 * connectors use (top-level `cursorRepos` array). Fail-open like the connector
 * loader: a missing file, bad JSON, or a malformed array yields an empty list
 * (no dispatchable repos) rather than crashing boot.
 */
function loadRepoAllowlist(): RepoAllowlist {
  const path = process.env['SYM_CONFIG_PATH']?.trim() || '.sym/config.json';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cursorRepos?: unknown };
    const result = repoAllowlistSchema.safeParse(parsed.cursorRepos ?? []);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

/** Build the optional Cursor config — only when a non-empty CURSOR_API_KEY is set. */
function loadCursorConfig(): CursorConfig | undefined {
  const apiKey = process.env['CURSOR_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const dbPath = process.env['SYM_CLOUD_DB_PATH']?.trim();
  return {
    apiKey,
    model: process.env['CURSOR_MODEL']?.trim() || 'composer-2.5',
    repoAllowlist: loadRepoAllowlist(),
    ...(dbPath !== undefined && dbPath.length > 0 ? { dbPath } : {}),
  };
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
  // Cloud-agent dispatch confirmation. Defaults to TRUE (safe): only an explicit
  // off value disables the preview gate.
  SYM_CLOUD_AGENT_CONFIRM: z
    .string()
    .optional()
    .transform((v) => v === undefined || !/^(0|false|no|off)$/i.test(v)),
  SYM_TURN_DEADLINE_MS: z.coerce.number().int().nonnegative().catch(DEFAULT_TURN_DEADLINE_MS),
  SYM_THREAD_HISTORY_LIMIT: z.coerce
    .number()
    .int()
    .nonnegative()
    .catch(DEFAULT_THREAD_HISTORY_LIMIT),
  // Home/default persona. Case-insensitive; unknown/missing falls back to the
  // default voice via the shared `resolvePersona` (same rule the CLI uses).
  SYM_PERSONA: z.string().optional().transform(resolvePersona),
});

export function loadAgentConfig(): AgentConfig {
  const connectors = loadConnectorConfigs();
  const behavior = behaviorEnvSchema.parse(process.env);
  const cursor = loadCursorConfig();
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
      persona: behavior.SYM_PERSONA,
      cloudAgentConfirm: behavior.SYM_CLOUD_AGENT_CONFIRM,
    },
    mcpServers: connectors.mcpServers,
    mcpConfigSource: connectors.source,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}
