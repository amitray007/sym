import { isSlackChannelId, isSlackDmId, threadToHistory } from '@sym/adapter-slack';

import { NameResolver } from './name-resolver.js';
import { runCli } from './run-cli.js';
import { safeFetch } from './safe-fetch.js';
import { webSearch } from './web-search.js';

import type { PlanController, PlanItemStatus } from './plan-controller.js';
import type { SearchMessageMatch, SlackClient, SlackThreadMessage } from '@sym/adapter-slack';
import type {
  JsonSchema,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  RenderIntent,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
} from '@sym/contracts';

/** Hard ceiling on fetch_url response size (chars after HTML strip). */
const FETCH_URL_DEFAULT_MAX = 8000;
/** Network timeout for fetch_url, in ms. */
const FETCH_URL_TIMEOUT_MS = 10_000;

const GET_CURRENT_TIME_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'get_current_time',
  description:
    'Get the current UTC date and time as an ISO 8601 string. Use when the user asks the time/date or you need the current moment.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

const READ_CHANNEL_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'read_channel',
  // READ tool. With actor:'user', sees private channels + DMs the owner is in
  // without Sym needing to be added as a member. Falls back to bot client when
  // SLACK_OWNER_USER_TOKEN isn't configured (then the bot-membership rule
  // applies as before).
  description:
    "Read the most recent messages of a Slack channel (oldest-first). Use to catch up on or summarize a channel other than the current one. `channel_id` is a Slack channel ID like C0123 (the model can read it from a `<#C0123|name>` mention in the user's message). Acts as the owner — can see any public channel, plus private channels and DMs the owner is in.",
  parameters: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Slack channel ID, e.g. C0123 or D0123 for a DM',
      },
      limit: {
        type: 'number',
        description: 'Max recent messages (default 30, max 100)',
      },
    },
    required: ['channel_id'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
  actor: 'user',
};

const READ_THREAD_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'read_thread',
  // READ tool: model supplies both channel_id and thread_ts from context.
  // Acts as owner via user token; private/DM threads accessible without bot
  // membership when the owner is a member.
  description:
    'Read all messages in a specific Slack thread (oldest-first). `channel_id` (C0123/D0123) and `thread_ts` identify the thread.',
  parameters: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
      },
      thread_ts: {
        type: 'string',
      },
    },
    required: ['channel_id', 'thread_ts'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
  actor: 'user',
};

const READ_USER_PROFILE_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'read_user_profile',
  // READ tool: model supplies user_id from <@U0123> mentions or search results.
  // User token surfaces a richer profile (some fields are user-scope only).
  description:
    "Fetch a Slack user's profile (display name, real name, title, status, timezone). `user_id` is a Slack user ID like U0123 (read from a `<@U0123>` mention).",
  parameters: {
    type: 'object',
    properties: {
      user_id: {
        type: 'string',
        description: 'Slack user ID, e.g. U0123',
      },
    },
    required: ['user_id'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
  actor: 'user',
};

const FETCH_URL_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'fetch_url',
  // READ tool: arbitrary http(s) fetch with HTML stripped to text. No JS rendering.
  description:
    'Fetch a web URL and return its text content (HTML stripped). Use to read docs, articles, or pages a user links to. Only http(s) URLs; 10s timeout; output is truncated.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL',
      },
      max_chars: {
        type: 'number',
        description: `Truncation cap (default ${FETCH_URL_DEFAULT_MAX})`,
      },
    },
    required: ['url'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

const WEB_SEARCH_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'web_search',
  // READ tool: keyless DuckDuckGo web search. Returns ranked title/url/snippet.
  description:
    'Search the web (DuckDuckGo, no API key). Returns ranked results with title, URL, and snippet. Use for current information, finding docs, or locating a URL to then read with fetch_url. Best-effort — may occasionally return nothing.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 8, max 10)' },
    },
    required: ['query'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

const RUN_CLI_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'run_cli',
  // Runs an allowlisted CLI by argv (no shell). NOT confirm-gated (no
  // destructiveHint) — the binary allowlist (SYM_CLI_ALLOWLIST) is the boundary.
  description:
    'Run an allowlisted command-line tool (e.g. sym, gog, gcloud, sentry-cli, gh, jq) by argv array — no shell, so no pipes/redirects. To inspect YOUR OWN connectors + tools, run ["sym","status"], ["sym","tools"], or ["sym","show","<connector>"] (add "--json" for structured output). To learn a CLI you do not know, FIRST run it with --help (e.g. ["gog","gmail","--help"]) or "<subcommand> --help", then run the real command. Returns stdout, stderr, and exit code. argv[0] must be a bare allowlisted binary name.',
  parameters: {
    type: 'object',
    properties: {
      argv: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command and arguments, e.g. ["gcloud","run","services","list"]',
      },
    },
    required: ['argv'],
    additionalProperties: false,
  } satisfies JsonSchema,
};

const LIST_CHANNELS_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'list_channels',
  // READ tool: with actor:'user' surfaces ALL channels the owner is in (public,
  // private, DMs, MPIMs). Falls back to bot's narrower view when user token
  // isn't configured.
  description:
    "List Slack channels the owner can see (public + private channels + DMs they're in). Returns id, name, topic, is_private, member_count. Use to discover channel IDs before calling read_channel.",
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max channels (default 50, max 200)',
      },
    },
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
  actor: 'user',
};

/**
 * Resolve every unique non-bot author id in `messages` to a display name via
 * the workspace-scoped resolver, returning a `Record<id, name>` for
 * `threadToHistory` to use as author labels. Failures fall through to raw
 * id (handled downstream).
 */
async function resolveAuthorNames(
  messages: SlackThreadMessage[],
  botUserId: SlackUserId,
  slack: SlackClient,
  resolver: NameResolver,
): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user !== undefined && m.user !== botUserId) ids.add(m.user);
  }
  await Promise.all([...ids].map((id) => resolver.resolveUser(id, slack)));
  const names: Record<string, string> = {};
  for (const id of ids) {
    const name = resolver.getUser(id);
    if (name !== undefined) names[id] = name;
  }
  return names;
}

/**
 * Format a list of Slack thread messages into a plain-text transcript with
 * display names resolved AND in-body mentions (`<@U…>`, `<#C…>`) rewritten
 * to `@Name` / `#name`. Sym's own posts are prefixed with "Sym:". When name
 * resolution fails, the raw id falls through — the model never sees raw
 * structured Slack markup, but it may see a bare id as last-resort context.
 */
async function formatTranscript(
  messages: SlackThreadMessage[],
  botUserId: SlackUserId,
  slack: SlackClient,
  resolver: NameResolver,
): Promise<string> {
  const names = await resolveAuthorNames(messages, botUserId, slack, resolver);
  const mapped = threadToHistory(messages, { botUserId, names });
  if (mapped.length === 0) return '(no messages)';
  const joined = mapped
    .map((m) => (m.role === 'assistant' ? `Sym: ${m.content ?? ''}` : (m.content ?? '')))
    .join('\n');
  // Final pass: rewrite any `<@U…>` / `<#C…>` mentions in message bodies.
  // resolveAuthorNames only touched author ids; mentions of OTHER users
  // inside message text still need resolution.
  return resolver.rewriteMentions(joined, slack);
}

/** A search match plus how many identical copies it collapsed. */
interface DedupedSearchMatch {
  match: SearchMessageMatch;
  count: number;
}

/**
 * Collapse identical search matches (same author + normalized text), preserving
 * order (best-by-sort first). Slack returns every repeat of a message as its
 * own match, so a frequently-repeated line (e.g. the same prompt sent many
 * times) can fill the result window with copies and bury unique content — the
 * model then sees a wall of one message and wrongly concludes "nothing here".
 * Keeps the first occurrence and counts the rest.
 */
function dedupeSearchMatches(matches: SearchMessageMatch[]): DedupedSearchMatch[] {
  const seen = new Map<string, DedupedSearchMatch>();
  const order: string[] = [];
  for (const m of matches) {
    const norm = (m.text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const key = `${m.userId ?? m.username ?? ''}|${norm}`;
    const hit = seen.get(key);
    if (hit) {
      hit.count += 1;
    } else {
      seen.set(key, { match: m, count: 1 });
      order.push(key);
    }
  }
  return order.map((k) => seen.get(k)!);
}

/**
 * Strip HTML tags and collapse whitespace. Intentionally naive — no cheerio.
 * Good enough for letting the model read the textual content of a page.
 */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Dependencies required by the built-in dispatcher.
 *
 * `slackClient` is the bot-token client (Sym's identity). `userSlackClient` is
 * the optional owner-token client. Per-tool actor routing picks one or the
 * other; READ tools that prefer user fall back to bot when the user token
 * isn't configured.
 */
export interface BuiltinToolDeps {
  slackClient: SlackClient;
  /** Owner user-token client; set when SLACK_OWNER_USER_TOKEN is configured. */
  userSlackClient?: SlackClient;
  botUserId: SlackUserId;
  /**
   * When true, `post_as_owner` appends a `_(via Sym)_` footer to the posted
   * message so collaborators can tell the owner used an assistant to relay it.
   * Driven by `BehaviorConfig.ownerPostMarker`.
   */
  ownerPostMarker?: boolean;
  /**
   * Per-turn plan controller backing the `set_plan` / `update_task` tools.
   * Optional: when absent (e.g. tests, non-streaming surfaces) those tools
   * fail cleanly with `execution_failed`. The streaming reply path always
   * supplies one.
   */
  planController?: PlanController;
  /**
   * Workspace-scoped name resolver shared across all turns. Used to rewrite
   * `<@U…>` / `<#C…>` markup in tool returns BEFORE the model sees it, so
   * raw ids can't leak into replies. Optional only for legacy test paths;
   * production always supplies one (constructed in `loadWorkspaceContext`).
   * When absent, tool returns include raw ids — degraded but functional.
   */
  nameResolver?: NameResolver;
}

/**
 * Pick the Slack client appropriate for this descriptor's `actor`.
 *
 * `actor: 'user'`:
 *  - user client present → use it
 *  - user client missing AND tool is read-only / non-destructive → fall back
 *    to the bot client (it'll still work, just with bot's narrower
 *    visibility)
 *  - user client missing AND tool is destructive → return null so the
 *    dispatcher emits an "unavailable" error (we will not silently post-as-
 *    Sym when the model asked for post-as-owner)
 *
 * `actor: 'bot'` or unset → always the bot client.
 */
function pickClient(
  descriptor: ToolDescriptor,
  deps: BuiltinToolDeps,
): { client: SlackClient; usedActor: 'bot' | 'user' } | null {
  if (descriptor.actor === 'user') {
    if (deps.userSlackClient !== undefined) {
      return { client: deps.userSlackClient, usedActor: 'user' };
    }
    if (descriptor.destructiveHint === true) {
      return null; // hard-required user token is missing
    }
    return { client: deps.slackClient, usedActor: 'bot' };
  }
  return { client: deps.slackClient, usedActor: 'bot' };
}

// ---------------------------------------------------------------------------
// Phase B — Act-as-owner write tools (user-token only)
// ---------------------------------------------------------------------------
//
// These tools use the owner's user token so the action shows up in Slack as
// being performed by the owner, not by Sym. Destructive ones ride the
// existing beforeToolCall confirmation flow (pi/loop.ts) — the owner must
// approve via a Slack button before they execute.

const POST_AS_OWNER_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'post_as_owner',
  description:
    'Post a Slack message AS THE OWNER (acts under the owner\'s identity, not as Sym). Use ONLY when the user EXPLICITLY asks Sym to send a message on their behalf — phrases like "send X to #channel as me", "post this on my behalf", "draft this and send it from my account". For Sym\'s OWN replies in the current thread, do NOT call this tool — just generate the reply text and Sym will post it itself. The owner must confirm via a Slack button before the message is sent.',
  parameters: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Where to post: channel ID (C0123), DM ID (D0123), or MPIM ID.',
      },
      text: {
        type: 'string',
        description: 'The message body. Markdown supported.',
      },
      thread_ts: {
        type: 'string',
        description: "Optional — reply in this thread root's `ts` instead of posting top-level.",
      },
    },
    required: ['channel_id', 'text'],
    additionalProperties: false,
  } satisfies JsonSchema,
  actor: 'user',
  destructiveHint: true,
};

const REACT_AS_OWNER_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'react_as_owner',
  description:
    'Add an emoji reaction to a Slack message AS THE OWNER. Use ONLY when the user explicitly asks "react with X as me" / "add a 👀 from me to that message". Owner confirms via Slack button before the reaction is added.',
  parameters: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Channel containing the message (C0123 / D0123).',
      },
      message_ts: {
        type: 'string',
        description: "The target message's `ts`.",
      },
      emoji: {
        type: 'string',
        description: 'Emoji alias WITHOUT colons (e.g. "thumbsup", "eyes", "white_check_mark").',
      },
    },
    required: ['channel_id', 'message_ts', 'emoji'],
    additionalProperties: false,
  } satisfies JsonSchema,
  actor: 'user',
  destructiveHint: true,
};

const SET_STATUS_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'set_status',
  description:
    'Update the owner\'s Slack profile status (text + optional emoji + optional expiration). Use ONLY when the user explicitly asks to set/change/clear their status — "set my status to \'in a meeting\'", "I\'m heads-down for the next hour", "clear my status". Pass an empty status_text to CLEAR the current status. Owner confirms via Slack button before the change is applied.',
  parameters: {
    type: 'object',
    properties: {
      status_text: {
        type: 'string',
        description: 'New status text. Empty string clears the existing status.',
      },
      status_emoji: {
        type: 'string',
        description:
          'Optional `:emoji:` shortcode WITH colons, e.g. `:palm_tree:`, `:headphones:`.',
      },
      expires_in_minutes: {
        type: 'number',
        description:
          'Optional — automatically clear the status after N minutes. Omit for no expiration.',
      },
    },
    required: ['status_text'],
    additionalProperties: false,
  } satisfies JsonSchema,
  actor: 'user',
  destructiveHint: true,
};

const ADD_REMINDER_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'add_reminder',
  description:
    'Set a Slack reminder for the owner (`reminders.add`). Use when the user asks "remind me to X at Y" / "set a reminder for X tomorrow morning". Slack accepts natural-language time strings ("in 10 minutes", "tomorrow at 9am", "next Tuesday at 3pm") or a unix-seconds timestamp. Low-risk — does NOT require confirmation. NOTE: Slack has been deprecating reminder APIs since March 2023 and they may return errors on some workspaces; if this tool fails, tell the owner reminders.add appears degraded for their workspace and suggest using Slack\'s native /remind slash command directly.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'What the reminder will say when it fires.',
      },
      time: {
        type: 'string',
        description:
          'When to fire the reminder. Natural-language ("in 10 minutes", "tomorrow at 9am") or a unix-seconds timestamp as a string.',
      },
    },
    required: ['text', 'time'],
    additionalProperties: false,
  } satisfies JsonSchema,
  actor: 'user',
  // Intentionally NOT destructive — adding a reminder is trivial to undo.
};

const SEARCH_MESSAGES_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'search_messages',
  description: [
    'Search the owner\'s SLACK messages across the workspace (`search.messages`). USE ONLY for questions ABOUT SLACK CONVERSATIONS — recaps, "what did I say/do in Slack", "who did I talk to", finding a past message or thread. It does NOT reach GitHub, cloud, issue trackers, an app\'s data, or ANY external system — for anything outside Slack use `find_tools` (connectors/CLIs), NEVER this tool. (e.g. "raise a PR", "list cloud resources", "what are my sentry issues" are NOT search_messages tasks.) Within Slack-content questions it is the primary tool — it covers every channel + DM, not one — so reach for it before read_channel / list_channels when you don\'t know the channel.',
    '',
    'Query syntax — Slack search modifiers (combine freely):',
    '  - `from:<@U042MBPUZ9N>`        find messages from a user by ID (most reliable)',
    "  - `from:@amit`                 find messages from a user by @-handle (use the owner's userName from the metadata block)",
    '  - `to:@amit`                   messages addressed to a user',
    '  - `in:#general`                limit to one channel',
    '  - `after:2026-05-26`           AFTER a date (exclusive), YYYY-MM-DD',
    '  - `before:2026-05-28`          BEFORE a date (exclusive), YYYY-MM-DD',
    '  - `on:2026-05-27`              a single calendar day',
    '  - `has:link` / `has:reaction`  attribute filters',
    '  - Plain words match the message content (e.g. `postgres migration`)',
    '',
    'Dates: prefer EXPLICIT `after:`/`before:`/`on:` with YYYY-MM-DD (call get_current_time first if you need today\'s date) — they are far more reliable than relative words. For "today", bound it with `after:<yesterday> before:<tomorrow>` or `on:<today>`. Note `after:`/`before:` are EXCLUSIVE, so widen by a day on each side when you want a full day inclusive.',
    'Sort: defaults to relevance (`score`). For ANY recency-oriented ask — "today", "recent", "latest", "what did I just", a date range — pass `sort=timestamp` so newest comes first and nothing recent gets buried below the relevance cutoff.',
    '',
    'Concrete worked examples:',
    '  - "what did I do today?"           →  query `from:<@OWNER_ID> on:<today>`, sort=timestamp',
    '  - "who did I talk to yesterday?"   →  query `from:<@OWNER_ID> on:<yesterday>`, sort=timestamp',
    '  - "what did I post in #eng?"       →  `from:<@OWNER_ID> in:#eng`',
    '  - "find the postgres discussion"   →  `postgres migration`',
    '  - "who mentioned the launch plan?" →  `launch plan`',
    '',
    "OWNER_ID is the owner's user id from the turn metadata block. Returns the most relevant matches with permalinks.",
    'RELIABILITY: search is an INDEX — a message sent in the last minute or two may not be searchable yet. If you expect a very recent message and search comes back empty, read the channel directly with read_channel instead of concluding nothing happened. If a query with modifiers returns nothing, retry once with the plain keywords (drop from:/in:/dates) before giving up. An empty result after that means it genuinely matched nothing — say so plainly; don\'t fall back to "channels you belong to" language.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Slack search query. Supports modifiers: from:@user, in:#channel, before:YYYY-MM-DD, after:YYYY-MM-DD, has:link, etc.',
      },
      limit: {
        type: 'number',
        description:
          'Max results (default 20, max 100). Raise to 50+ for "everything I did" sweeps.',
      },
      sort: {
        type: 'string',
        enum: ['score', 'timestamp'],
        description: 'Rank by relevance (score, default) or recency (timestamp).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
  // search.messages requires the user-token `search:read` scope (bot tokens
  // cannot hold it). Falls back to bot client only if Sym is configured
  // without a user token, in which case this tool will return an API error.
  actor: 'user',
};

// ---------------------------------------------------------------------------
// Self-maintenance — Sym deleting its OWN messages (bot token)
// ---------------------------------------------------------------------------
//
// Unlike the act-as-owner tools above, this acts as SYM itself (bot token —
// the default actor, NOT the owner's user token). Slack's `chat.delete` with a
// bot token can only remove messages the bot itself posted; targeting anyone
// else's message fails at the API, so the "own messages only" rule is enforced
// by Slack, not by us. Destructive + irreversible → rides the existing
// confirm-before-destructive flow (the owner approves via a Slack button).

const DELETE_MESSAGE_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'delete_message',
  description:
    'Delete one of SYM\'S OWN Slack messages — a message Sym previously posted. Use when the owner asks to remove/delete/take down something SYM said: "delete that", "remove your last message", "take down the reply you just posted". You CAN do this — never claim you cannot delete your own messages. Identify the target with `channel_id` (C0123 / D0123) and `message_ts`, read from the current thread, a search result, or a Slack permalink (the digits after `/p` form the ts: `p1780221572271599` → `1780221572.271599`). Sym can ONLY delete its own messages; targeting another author\'s message fails. Irreversible — the owner confirms via a Slack button before it runs.',
  parameters: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Channel or DM containing the message (C0123 / D0123).',
      },
      message_ts: {
        type: 'string',
        description: "The target message's `ts`, e.g. 1780221572.271599.",
      },
    },
    required: ['channel_id', 'message_ts'],
    additionalProperties: false,
  } satisfies JsonSchema,
  destructiveHint: true,
  // actor defaults to 'bot' — Sym deletes its own messages with the bot token.
};

// ---------------------------------------------------------------------------
// Planning tools — model-authored intent (mode-switches the task card)
// ---------------------------------------------------------------------------
//
// These two tools let the model externalize its plan *before* doing work, so
// the task card reflects what the owner asked for (intent) instead of the
// mechanics (tool names). Both are pure controller-mutations: no Slack API
// calls, no auth, no actor routing. They cannot be destructive.

const SET_PLAN_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'set_plan',
  description: [
    "Externalize your plan BEFORE doing the work. Call this exactly once at the start of a turn when the owner's ask requires more than one tool call OR more than one user-visible outcome (research + summarize + reminder, compare A vs B, refactor + verify, etc.).",
    '',
    "Each item is a concrete outcome the OWNER cares about — phrased as a short imperative ('Find the latest incident', 'Summarize learnings', 'Set the reminder'). NOT tool names ('search_messages'). 2–6 items.",
    '',
    "SKIP this tool for single-action asks ('what time is it?', 'who did I DM yesterday?', 'remind me at 5pm') — just answer.",
    '',
    'Idempotent: once called, the plan is locked for this turn (subsequent calls return `already_planned`). After calling, use `update_task` to flip each item to `in_progress` when you start it and `complete` when done.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered plan items. 2–6 entries, each a concrete user-visible outcome.',
      },
    },
    required: ['items'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

const UPDATE_TASK_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'update_task',
  description: [
    'Update a plan item created by `set_plan`. Call `in_progress` when you start working on an item; `complete` when finished; `blocked` if you need owner input and cannot proceed (supply a `note` with the reason).',
    '',
    'Returns `ok: false, reason: "no_plan"` if `set_plan` was never called, or `unknown_id` if the id does not match any item — in both cases this signals a model error; recover by skipping the update and continuing.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Plan item id, e.g. `p1`, `p2` (returned by `set_plan`).',
      },
      status: {
        type: 'string',
        enum: ['in_progress', 'complete', 'blocked'],
        description: 'New status. Use `blocked` only when owner input is required.',
      },
      note: {
        type: 'string',
        description: 'Optional short context shown under the item. Required when `status=blocked`.',
      },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

const PRESENT_CARD_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'present_card',
  description: [
    'Present the answer as a CARD when the answer IS one record the owner will act on — an incident, a PR, a person, a channel, a config item. Renders a title, a one-line summary, a small label/value grid (status, owner, priority, updated, …), and optional link buttons.',
    '',
    'Use ONLY for a single structured record. Do NOT use it for a plain prose answer, a one-liner, or a list (for a list to compare, use present_table; search results already render as a table automatically).',
    '',
    'After calling, write only a ONE-LINE lead in your reply — do NOT restate the title or fields in prose; the owner already sees the card.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Card title — the record name, e.g. "INC-204 · API latency".',
      },
      body: { type: 'string', description: 'Optional one-line decision-critical summary.' },
      fields: {
        type: 'array',
        description: 'Up to 10 label/value pairs (status, owner, priority, updated, …).',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, value: { type: 'string' } },
          required: ['label', 'value'],
          additionalProperties: false,
        },
      },
      actions: {
        type: 'array',
        description: 'Optional link buttons (label + https url). Links only — no in-Slack actions.',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, url: { type: 'string' } },
          required: ['label', 'url'],
          additionalProperties: false,
        },
      },
    },
    required: ['title'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

const PRESENT_TABLE_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'present_table',
  description: [
    'Present the answer as a TABLE when it is a small set of rows the owner will compare or scan that YOU synthesized — a comparison (A vs B vs C), a shortlist, a breakdown. `columns` are headers; each row is an array of cell strings aligned to the columns.',
    '',
    'Use ONLY when a table reads better than prose. Do NOT use it for a single record (use present_card), a one-line answer, or for search results (those auto-render as a table).',
    '',
    'After calling, write only a ONE-LINE lead — do NOT restate the rows in prose.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      caption: { type: 'string', description: 'Optional one-line lead shown above the table.' },
      columns: {
        type: 'array',
        description: 'Column headers, left to right (max 20).',
        items: { type: 'string' },
      },
      rows: {
        type: 'array',
        description: 'Rows; each row is an array of cell strings aligned to columns.',
        items: { type: 'array', items: { type: 'string' } },
      },
    },
    required: ['columns', 'rows'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

/** Coerce model-supplied card fields to valid {label,value} pairs (drops malformed). */
function coerceCardFields(raw: unknown): { label: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; value: string }[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const label = (entry as Record<string, unknown>)['label'];
      const value = (entry as Record<string, unknown>)['value'];
      if (typeof label === 'string' && typeof value === 'string') out.push({ label, value });
    }
  }
  return out;
}

/** Coerce model-supplied card actions to valid {label,url} link buttons (https only). */
function coerceCardActions(raw: unknown): { label: string; url: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; url: string }[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const label = (entry as Record<string, unknown>)['label'];
      const url = (entry as Record<string, unknown>)['url'];
      if (typeof label === 'string' && typeof url === 'string' && /^https?:\/\//.test(url)) {
        out.push({ label, url });
      }
    }
  }
  return out;
}

/**
 * Lookup table built once per dispatcher — used to resolve a `ToolCall.name`
 * back to its descriptor so the dispatcher can route to the bot or user
 * Slack client based on the descriptor's `actor` field.
 */
const ALL_BUILTIN_DESCRIPTORS: ToolDescriptor[] = [
  GET_CURRENT_TIME_DESCRIPTOR,
  READ_CHANNEL_DESCRIPTOR,
  READ_THREAD_DESCRIPTOR,
  READ_USER_PROFILE_DESCRIPTOR,
  FETCH_URL_DESCRIPTOR,
  WEB_SEARCH_DESCRIPTOR,
  RUN_CLI_DESCRIPTOR,
  LIST_CHANNELS_DESCRIPTOR,
  SEARCH_MESSAGES_DESCRIPTOR,
  POST_AS_OWNER_DESCRIPTOR,
  REACT_AS_OWNER_DESCRIPTOR,
  SET_STATUS_DESCRIPTOR,
  ADD_REMINDER_DESCRIPTOR,
  DELETE_MESSAGE_DESCRIPTOR,
  SET_PLAN_DESCRIPTOR,
  UPDATE_TASK_DESCRIPTOR,
  PRESENT_CARD_DESCRIPTOR,
  PRESENT_TABLE_DESCRIPTOR,
];
const DESCRIPTORS_BY_NAME = new Map<string, ToolDescriptor>(
  ALL_BUILTIN_DESCRIPTORS.map((d) => [d.name, d]),
);

/**
 * Create the built-in in-process tool dispatcher.
 *
 * Provides: `get_current_time`, `read_channel`, `read_thread`,
 * `read_user_profile`, `fetch_url`, `list_channels`, `search_messages`.
 * Per-tool actor routing picks the bot or user Slack client based on the
 * descriptor's `actor` field; READ tools prefer the user client (broader
 * visibility) and fall back to bot when no user token is configured.
 */
export function createBuiltinDispatcher(deps: BuiltinToolDeps): ToolDispatcher {
  // Workspace-scoped name resolver — preferred. Falls back to an ad-hoc
  // per-dispatcher resolver if deps.nameResolver wasn't supplied (legacy
  // test paths). Either way the same code paths apply; production always
  // wires the shared one via `loadWorkspaceContext` for cross-turn reuse.
  const resolver = deps.nameResolver ?? new NameResolver();

  // Per-turn search dedup. The model sometimes re-runs the IDENTICAL query
  // several times in one turn — each costs ~400ms and re-bloats the context,
  // pushing the turn toward a request timeout. This dispatcher lives for one
  // turn, so caching by exact (query+sort+limit) is safe: results can't
  // meaningfully change mid-turn. Cached on success only.
  const searchCache = new Map<string, ToolResult>();

  return {
    list(): ToolDescriptor[] {
      return ALL_BUILTIN_DESCRIPTORS;
    },

    async dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> {
      let result: ToolResult;

      // Look up the descriptor so we can route to the correct token client.
      const descriptor = DESCRIPTORS_BY_NAME.get(call.name);

      // pickClient is null only for hard-required user tools with no user token.
      const pick = descriptor
        ? pickClient(descriptor, deps)
        : { client: deps.slackClient, usedActor: 'bot' as const };
      if (pick === null) {
        return {
          callId: call.id,
          ok: false,
          error: {
            code: 'execution_failed',
            message: `${call.name} requires the owner user token (SLACK_OWNER_USER_TOKEN). Not configured on this deployment.`,
          },
        };
      }
      const slack = pick.client;

      if (call.name === 'get_current_time') {
        result = { callId: call.id, ok: true, content: new Date().toISOString() };
      } else if (call.name === 'read_channel') {
        const channelIdArg = call.arguments['channel_id'];
        if (typeof channelIdArg !== 'string' || channelIdArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'channel_id must be a non-empty string' },
          };
        } else {
          const limitArg = call.arguments['limit'];
          const rawLimit = typeof limitArg === 'number' ? limitArg : 30;
          const limit = Math.max(1, Math.min(100, rawLimit));

          try {
            const { messages } = await slack.conversationsHistory({
              channel: channelIdArg as SlackChannelId,
              limit,
            });
            const transcript = await formatTranscript(messages, deps.botUserId, slack, resolver);
            result = { callId: call.id, ok: true, content: transcript };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
          }
        }
      } else if (call.name === 'read_thread') {
        const channelIdArg = call.arguments['channel_id'];
        const threadTsArg = call.arguments['thread_ts'];
        if (typeof channelIdArg !== 'string' || channelIdArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'channel_id must be a non-empty string' },
          };
        } else if (typeof threadTsArg !== 'string' || threadTsArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'thread_ts must be a non-empty string' },
          };
        } else {
          try {
            const { messages } = await slack.conversationsReplies({
              channel: channelIdArg as SlackChannelId,
              ts: threadTsArg as SlackThreadTs,
            });
            const transcript = await formatTranscript(messages, deps.botUserId, slack, resolver);
            result = { callId: call.id, ok: true, content: transcript };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
          }
        }
      } else if (call.name === 'read_user_profile') {
        const userIdArg = call.arguments['user_id'];
        if (typeof userIdArg !== 'string' || userIdArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'user_id must be a non-empty string' },
          };
        } else {
          try {
            const profile = await slack.usersInfo({ user: userIdArg as SlackUserId });
            const lines: string[] = [`id: ${profile.id}`];
            if (profile.displayName) lines.push(`display_name: ${profile.displayName}`);
            if (profile.realName) lines.push(`real_name: ${profile.realName}`);
            if (profile.title) lines.push(`title: ${profile.title}`);
            // Email is only present when the calling token has `users:read.email`.
            if (profile.email) lines.push(`email: ${profile.email}`);
            if (profile.statusText) {
              const emoji = profile.statusEmoji ? `${profile.statusEmoji} ` : '';
              // Statuses occasionally contain `<@U…>` references (e.g. "in
              // a 1:1 with <@U042>"). Run through the resolver so DM-style
              // ids normalize to `<@USERID>` tokens (Slack-renderable) and no
              // raw `D…` leaks. Best-effort; raw text falls through on miss.
              const statusText = await resolver
                .rewriteMentions(profile.statusText, slack)
                .catch(() => profile.statusText ?? '');
              lines.push(`status: ${emoji}${statusText}`);
            }
            if (profile.tz) lines.push(`tz: ${profile.tz}`);
            if (profile.isBot) lines.push('is_bot: true');
            if (profile.deleted) lines.push('deleted: true');
            result = { callId: call.id, ok: true, content: lines.join('\n') };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
          }
        }
      } else if (call.name === 'fetch_url') {
        const urlArg = call.arguments['url'];
        if (typeof urlArg !== 'string' || urlArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'url must be a non-empty string' },
          };
        } else {
          let parsed: URL | undefined;
          try {
            parsed = new URL(urlArg);
          } catch {
            parsed = undefined;
          }
          if (
            parsed === undefined ||
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
          ) {
            result = {
              callId: call.id,
              ok: false,
              error: {
                code: 'invalid_arguments',
                message: 'url must be an absolute http(s) URL',
              },
            };
          } else {
            const maxCharsArg = call.arguments['max_chars'];
            const maxChars = Math.max(
              200,
              typeof maxCharsArg === 'number' ? maxCharsArg : FETCH_URL_DEFAULT_MAX,
            );
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
            try {
              // SSRF-guarded: blocks private/reserved/metadata hosts and
              // re-validates every redirect hop. See safe-fetch.ts.
              const res = await safeFetch(parsed.toString(), {
                signal: controller.signal,
                headers: { 'user-agent': 'Sym/1.0 (+slack-agent)' },
              });
              if (!res.ok) {
                result = {
                  callId: call.id,
                  ok: false,
                  error: {
                    code: 'execution_failed',
                    message: `HTTP ${res.status} ${res.statusText}`,
                  },
                };
              } else {
                const contentType = res.headers.get('content-type') ?? '';
                const raw = await res.text();
                const text = /html|xml/i.test(contentType) ? stripHtmlToText(raw) : raw.trim();
                const truncated =
                  text.length > maxChars
                    ? `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`
                    : text;
                result = { callId: call.id, ok: true, content: truncated };
              }
            } catch (err: unknown) {
              const aborted =
                err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
              const message = aborted
                ? `fetch timed out after ${FETCH_URL_TIMEOUT_MS}ms`
                : err instanceof Error
                  ? err.message
                  : String(err);
              result = {
                callId: call.id,
                ok: false,
                error: { code: 'execution_failed', message },
              };
            } finally {
              clearTimeout(timer);
            }
          }
        }
      } else if (call.name === 'web_search') {
        const queryArg = call.arguments['query'];
        if (typeof queryArg !== 'string' || queryArg.trim().length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'query must be a non-empty string' },
          };
        } else {
          const limitArg = call.arguments['limit'];
          const limit = Math.max(1, Math.min(10, typeof limitArg === 'number' ? limitArg : 8));
          try {
            const hits = await webSearch(queryArg, { limit });
            if (hits.length === 0) {
              result = {
                callId: call.id,
                ok: true,
                content: `No web results for "${queryArg.trim()}".`,
              };
            } else {
              const body = hits
                .map(
                  (h, i) =>
                    `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`,
                )
                .join('\n');
              result = { callId: call.id, ok: true, content: body };
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = { callId: call.id, ok: false, error: { code: 'execution_failed', message } };
          }
        }
      } else if (call.name === 'run_cli') {
        const argvArg = call.arguments['argv'];
        if (
          !Array.isArray(argvArg) ||
          argvArg.length === 0 ||
          !argvArg.every((a) => typeof a === 'string')
        ) {
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'invalid_arguments',
              message: 'argv must be a non-empty string array, e.g. ["gog","gmail","--help"]',
            },
          };
        } else {
          const argv = argvArg as string[];
          const r = await runCli(argv);
          if (r.error !== undefined && r.code === null && !r.timedOut) {
            // Allowlist/spawn failure — the command never ran.
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message: r.error },
            };
          } else {
            const out = r.stdout.length > 0 ? `\nstdout:\n${r.stdout}` : '';
            const errOut = r.stderr.length > 0 ? `\nstderr:\n${r.stderr}` : '';
            // ok:true even on non-zero exit so the model can read stderr / --help
            // output and adapt (e.g. fix a wrong subcommand).
            result = {
              callId: call.id,
              ok: true,
              content: `$ ${argv.join(' ')}\nexit: ${r.timedOut ? 'TIMEOUT' : r.code}${out}${errOut}`,
            };
          }
        }
      } else if (call.name === 'list_channels') {
        const limitArg = call.arguments['limit'];
        const rawLimit = typeof limitArg === 'number' ? limitArg : 50;
        const limit = Math.max(1, Math.min(200, rawLimit));
        try {
          // When acting as user, include DMs + MPIMs in the visible set.
          const types =
            pick.usedActor === 'user'
              ? 'public_channel,private_channel,mpim,im'
              : 'public_channel,private_channel';
          const { channels } = await slack.conversationsList({
            limit,
            types,
            excludeArchived: true,
          });
          if (channels.length === 0) {
            result = { callId: call.id, ok: true, content: '(no channels)' };
          } else {
            // Topics can mention other users / channels by id. Rewrite each
            // topic through the resolver in parallel so the model never sees
            // raw `<@U…>` / `<#C…>` markup leaking out via this listing.
            const rewrittenTopics = await Promise.all(
              channels.map((c) =>
                c.topic !== undefined && c.topic.length > 0
                  ? resolver.rewriteMentions(c.topic, slack).catch(() => c.topic ?? '')
                  : Promise.resolve(''),
              ),
            );
            const body = channels
              .map((c, i) => {
                const name = c.name ? `#${c.name}` : '(no name)';
                const priv = c.isPrivate ? ' [private]' : '';
                const members = c.memberCount !== undefined ? ` (${c.memberCount} members)` : '';
                const topicText = rewrittenTopics[i] ?? '';
                const topic = topicText.length > 0 ? ` — ${topicText}` : '';
                return `- ${c.id} ${name}${priv}${members}${topic}`;
              })
              .join('\n');
            result = { callId: call.id, ok: true, content: body };
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'execution_failed', message },
          };
        }
      } else if (call.name === 'search_messages') {
        const queryArg = call.arguments['query'];
        if (typeof queryArg !== 'string' || queryArg.trim().length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'query must be a non-empty string' },
          };
        } else if (pick.usedActor !== 'user') {
          // Bot tokens cannot hold `search:read`, so search.messages always
          // fails when called as the bot. Surface a clean error rather than
          // letting Slack return a confusing missing_scope.
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'execution_failed',
              message:
                'workspace search requires SLACK_OWNER_USER_TOKEN — Slack bot tokens cannot hold the search:read scope',
            },
          };
        } else {
          const limitArg = call.arguments['limit'];
          const rawLimit = typeof limitArg === 'number' ? limitArg : 20;
          const limit = Math.max(1, Math.min(100, rawLimit));
          const sortArg = call.arguments['sort'];
          const sort: 'score' | 'timestamp' = sortArg === 'timestamp' ? 'timestamp' : 'score';
          const cacheKey = `${queryArg.trim()}|${sort}|${limit}`;
          const cachedSearch = searchCache.get(cacheKey);
          if (cachedSearch !== undefined && cachedSearch.ok) {
            // Identical query already run this turn — reuse the payload with a
            // FRESH callId (Pi matches tool results by callId).
            console.info(
              `[tools] search_messages query=${JSON.stringify(queryArg.trim())} → cache hit (this turn)`,
            );
            result = { ...cachedSearch, callId: call.id };
          } else {
            try {
              const startMs = Date.now();
              // Fetch headroom so dedup has room to surface unique messages even
              // when one line is repeated many times (Slack returns each repeat
              // as its own match). We still SHOW at most `limit` unique.
              const fetchCount = Math.min(100, Math.max(limit, 30));
              const { matches: rawMatches, total } = await slack.searchMessages({
                query: queryArg.trim(),
                count: fetchCount,
                sort,
              });
              // Visible-in-logs diagnostic so we can tell "didn't call it" from
              // "called it, got empty" when triaging "Sym says no activity"
              // reports. No message bodies — just query + count.
              console.info(
                `[tools] search_messages query=${JSON.stringify(queryArg.trim())} ` +
                  `→ ${rawMatches.length}/${total} matches in ${Date.now() - startMs}ms`,
              );
              if (rawMatches.length === 0) {
                result = { callId: call.id, ok: true, content: '(no matching messages)' };
              } else {
                // Collapse identical repeats (same author + text) so real content
                // isn't buried under copies, then show up to `limit` unique.
                const deduped = dedupeSearchMatches(rawMatches).slice(0, limit);
                const header =
                  deduped.length < rawMatches.length
                    ? `(${total} total matches; showing ${deduped.length} unique — identical repeats collapsed)\n`
                    : total > rawMatches.length
                      ? `(showing ${rawMatches.length} of ${total} matches)\n`
                      : '';
                // Resolve author + channel/DM ids for the SHOWN matches upfront
                // so per-line formatting stays synchronous. A DM channel (`D…`)
                // resolves to its counterpart user; a real channel (`C…`) to its
                // name. A raw id must NEVER reach the model or the owner.
                const authorIds = deduped
                  .map((d) => d.match.userId as string | undefined)
                  .filter((id): id is string => id !== undefined && id.length > 0);
                const channelIds = deduped
                  .map((d) => d.match.channelId as string | undefined)
                  .filter((id): id is string => id !== undefined && id.length > 0);
                await Promise.all([
                  ...authorIds.map((id) => resolver.resolveUser(id, slack)),
                  ...channelIds.map((id) =>
                    isSlackDmId(id)
                      ? resolver.resolveDmParticipant(id, slack)
                      : resolver.resolveChannel(id, slack),
                  ),
                ]);
                const rewrittenTexts = await Promise.all(
                  deduped.map((d) => resolver.rewriteMentions(d.match.text, slack)),
                );
                // Per-row fields in two flavors:
                //  - `*Tag` for the prose body → Slack mrkdwn renders `<@U…>` /
                //    `<#C…>` as clickable, notifying mentions (native tagging);
                //  - `*Cell` for the `table` render → raw_text cells can't render
                //    tokens, so they get plain names (via `flattenToNames`).
                const fieldsFor = (d: DedupedSearchMatch) => {
                  const m = d.match;
                  const name = m.userId !== undefined ? resolver.getUser(m.userId) : undefined;
                  const whoTag =
                    m.userId !== undefined ? `<@${m.userId}>` : (m.username ?? '(unknown)');
                  const whoCell = name ?? m.username ?? '(unknown)';
                  const cid = m.channelId;
                  let whereTag: string;
                  let whereCell: string;
                  if (cid !== undefined && isSlackDmId(cid)) {
                    const dm = resolver.getDmParticipant(cid);
                    whereTag = dm.userId !== undefined ? `a DM with <@${dm.userId}>` : 'a DM';
                    whereCell = dm.name !== undefined ? `DM with ${dm.name}` : 'Direct message';
                  } else {
                    const channelName =
                      m.channelName ?? (cid !== undefined ? resolver.getChannel(cid) : undefined);
                    if (cid !== undefined && isSlackChannelId(cid)) {
                      whereTag = `<#${cid}>`;
                      whereCell = channelName ? `#${channelName}` : '#channel';
                    } else if (channelName) {
                      whereTag = `#${channelName}`;
                      whereCell = `#${channelName}`;
                    } else {
                      whereTag = 'a conversation';
                      whereCell = 'a conversation';
                    }
                  }
                  const rep = d.count > 1 ? ` (sent ${d.count}×)` : '';
                  return { whoTag, whoCell, whereTag, whereCell, rep, permalink: m.permalink };
                };
                const body = deduped
                  .map((d, i) => {
                    const { whoTag, whereTag, rep, permalink } = fieldsFor(d);
                    const raw = rewrittenTexts[i] ?? d.match.text;
                    const link = permalink ? ` [link](${permalink})` : '';
                    const content = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
                    return `${i + 1}. ${whoTag} in ${whereTag}${link}${rep}\n   ${content}`;
                  })
                  .join('\n');
                // Presentation hint: render the same matches as a Slack `table`
                // (code-owned blocks; the model still reasons over `content`).
                const render: RenderIntent = {
                  kind: 'table',
                  columns: [{ header: 'From' }, { header: 'Channel' }, { header: 'Message' }],
                  rows: deduped.map((d, i) => {
                    const { whoCell, whereCell, rep, permalink } = fieldsFor(d);
                    // Plain names in cells — tokens would render literally here.
                    const raw = resolver.flattenToNames(rewrittenTexts[i] ?? d.match.text);
                    const preview = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
                    // A message with no text (bot/app alerts whose content is in
                    // attachments) would leave the cell empty — Slack rejects an
                    // empty link cell. Use a readable placeholder instead.
                    const text = `${preview}${rep}`.trim() || '(no message text)';
                    return [
                      { text: whoCell },
                      { text: whereCell },
                      permalink ? { text, link: permalink } : { text },
                    ];
                  }),
                };
                result = { callId: call.id, ok: true, content: `${header}${body}`, render };
              }
              searchCache.set(cacheKey, result);
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              result = {
                callId: call.id,
                ok: false,
                error: { code: 'execution_failed', message },
              };
            }
          }
        }
      } else if (call.name === 'post_as_owner') {
        const channelArg = call.arguments['channel_id'];
        const textArg = call.arguments['text'];
        const threadTsArg = call.arguments['thread_ts'];
        if (typeof channelArg !== 'string' || channelArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'channel_id must be a non-empty string' },
          };
        } else if (typeof textArg !== 'string' || textArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'text must be a non-empty string' },
          };
        } else {
          // Optional transparency marker — disabled via OWNER_POST_MARKER=false.
          const body = deps.ownerPostMarker === true ? `${textArg}\n_(via Sym)_` : textArg;
          try {
            const posted = await slack.chatPostMessage({
              channel: channelArg as SlackChannelId,
              text: body,
              ...(typeof threadTsArg === 'string' && threadTsArg.length > 0
                ? { thread_ts: threadTsArg as SlackThreadTs }
                : {}),
            });
            result = {
              callId: call.id,
              ok: true,
              content: `posted as owner to ${channelArg} at ${posted.ts}`,
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
          }
        }
      } else if (call.name === 'react_as_owner') {
        const channelArg = call.arguments['channel_id'];
        const tsArg = call.arguments['message_ts'];
        const emojiArg = call.arguments['emoji'];
        if (typeof channelArg !== 'string' || channelArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'channel_id must be a non-empty string' },
          };
        } else if (typeof tsArg !== 'string' || tsArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'message_ts must be a non-empty string' },
          };
        } else if (typeof emojiArg !== 'string' || emojiArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'emoji must be a non-empty string' },
          };
        } else {
          // Strip any leading/trailing colons the model might add habitually.
          const name = emojiArg.replace(/^:|:$/g, '');
          try {
            await slack.reactionsAdd({
              channel: channelArg as SlackChannelId,
              timestamp: tsArg as SlackThreadTs,
              name,
            });
            result = {
              callId: call.id,
              ok: true,
              content: `reacted :${name}: as owner on ${channelArg}/${tsArg}`,
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
          }
        }
      } else if (call.name === 'set_status') {
        const textArg = call.arguments['status_text'];
        const emojiArg = call.arguments['status_emoji'];
        const expiresArg = call.arguments['expires_in_minutes'];
        if (typeof textArg !== 'string') {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'status_text must be a string' },
          };
        } else {
          // Resolve expires_in_minutes → unix seconds.
          const expiration =
            typeof expiresArg === 'number' && expiresArg > 0
              ? Math.floor(Date.now() / 1000) + Math.floor(expiresArg * 60)
              : undefined;
          try {
            await slack.usersProfileSet({
              statusText: textArg,
              ...(typeof emojiArg === 'string' && emojiArg.length > 0
                ? { statusEmoji: emojiArg }
                : {}),
              ...(expiration !== undefined ? { statusExpiration: expiration } : {}),
            });
            const summary =
              textArg.length === 0
                ? 'status cleared'
                : `status set to "${textArg}"${typeof emojiArg === 'string' && emojiArg.length > 0 ? ` ${emojiArg}` : ''}${expiration !== undefined ? ` (expires in ${expiresArg as number} min)` : ''}`;
            result = { callId: call.id, ok: true, content: summary };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
          }
        }
      } else if (call.name === 'add_reminder') {
        const textArg = call.arguments['text'];
        const timeArg = call.arguments['time'];
        if (typeof textArg !== 'string' || textArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'text must be a non-empty string' },
          };
        } else if (typeof timeArg !== 'string' && typeof timeArg !== 'number') {
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'invalid_arguments',
              message: 'time must be a string (natural language) or number (unix seconds)',
            },
          };
        } else {
          try {
            const reminder = await slack.remindersAdd({ text: textArg, time: timeArg });
            const when =
              reminder.time !== undefined
                ? ` for ${new Date(reminder.time * 1000).toISOString()}`
                : '';
            result = {
              callId: call.id,
              ok: true,
              content: `reminder set${when}: "${reminder.text}" (id ${reminder.id})`,
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
          }
        }
      } else if (call.name === 'delete_message') {
        const channelArg = call.arguments['channel_id'];
        const tsArg = call.arguments['message_ts'];
        if (typeof channelArg !== 'string' || channelArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'channel_id must be a non-empty string' },
          };
        } else if (typeof tsArg !== 'string' || tsArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'message_ts must be a non-empty string' },
          };
        } else {
          try {
            // Bot-token delete — `slack` is the bot client (delete_message has
            // no actor:'user', so pickClient returned it). Slack only permits
            // deleting messages this bot authored.
            await slack.chatDelete({
              channel: channelArg as SlackChannelId,
              ts: tsArg as SlackThreadTs,
            });
            result = {
              callId: call.id,
              ok: true,
              content: `deleted Sym's message ${tsArg} in ${channelArg}`,
            };
          } catch (err: unknown) {
            // Slack returns `cant_delete_message` / `message_not_found` when the
            // target isn't Sym's own message (or it's already gone). Surface the
            // raw Slack reason plus the one constraint the model can act on.
            const reason = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: {
                code: 'execution_failed',
                message: `${reason} — Sym can only delete messages it posted itself.`,
              },
            };
          }
        }
      } else if (call.name === 'set_plan') {
        // Planning tool — no Slack client, no actor routing. Idempotent latch.
        const itemsArg = call.arguments['items'];
        if (!Array.isArray(itemsArg) || itemsArg.some((v) => typeof v !== 'string')) {
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'invalid_arguments',
              message: 'items must be an array of strings',
            },
          };
        } else if (deps.planController === undefined) {
          // No controller wired (test path, non-streaming surface). Fail
          // cleanly so the model knows planning isn't available and just
          // proceeds without a card.
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'execution_failed',
              message: 'Planning is not available on this surface — answer the request directly.',
            },
          };
        } else {
          const planResult = await deps.planController.setPlan(itemsArg as string[]);
          // Hand the model a plain JsonObject — typed `SetPlanResult` doesn't
          // satisfy ToolSuccess.content (which expects an index-signature JSON
          // shape, not a closed interface).
          const content = {
            ok: planResult.ok,
            ids: planResult.ids,
            ...(planResult.reason !== undefined ? { reason: planResult.reason } : {}),
          };
          result = { callId: call.id, ok: true, content };
        }
      } else if (call.name === 'update_task') {
        const idArg = call.arguments['id'];
        const statusArg = call.arguments['status'];
        const noteArg = call.arguments['note'];
        if (typeof idArg !== 'string' || idArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'id must be a non-empty string' },
          };
        } else if (
          typeof statusArg !== 'string' ||
          !['in_progress', 'complete', 'blocked'].includes(statusArg)
        ) {
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'invalid_arguments',
              message: 'status must be one of: in_progress, complete, blocked',
            },
          };
        } else if (noteArg !== undefined && typeof noteArg !== 'string') {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'note must be a string when present' },
          };
        } else if (deps.planController === undefined) {
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'execution_failed',
              message: 'Planning is not available on this surface.',
            },
          };
        } else {
          const updateResult = await deps.planController.updateTask(
            idArg,
            statusArg as PlanItemStatus,
            typeof noteArg === 'string' ? noteArg : undefined,
          );
          const content = {
            ok: updateResult.ok,
            ...(updateResult.reason !== undefined ? { reason: updateResult.reason } : {}),
          };
          result = { callId: call.id, ok: true, content };
        }
      } else if (call.name === 'present_card') {
        // Presentation tool — no Slack client. Validates args, attaches a `card`
        // render that the adapter turns into header+fields+buttons. The model
        // still writes the one-line lead; `content` nudges it not to duplicate.
        const titleArg = call.arguments['title'];
        if (typeof titleArg !== 'string' || titleArg.trim().length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'title must be a non-empty string' },
          };
        } else {
          const bodyArg = call.arguments['body'];
          const fields = coerceCardFields(call.arguments['fields']);
          const actions = coerceCardActions(call.arguments['actions']);
          const render: RenderIntent = {
            kind: 'card',
            title: titleArg,
            ...(typeof bodyArg === 'string' && bodyArg.length > 0 ? { body: bodyArg } : {}),
            ...(fields.length > 0 ? { fields } : {}),
            ...(actions.length > 0 ? { actions } : {}),
          };
          result = {
            callId: call.id,
            ok: true,
            content:
              'Card shown to the owner. Write only a one-line lead; do not restate the fields.',
            render,
          };
        }
      } else if (call.name === 'present_table') {
        const columnsArg = call.arguments['columns'];
        const rowsArg = call.arguments['rows'];
        if (
          !Array.isArray(columnsArg) ||
          columnsArg.length === 0 ||
          columnsArg.some((c) => typeof c !== 'string')
        ) {
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'invalid_arguments',
              message: 'columns must be a non-empty array of strings',
            },
          };
        } else if (
          !Array.isArray(rowsArg) ||
          !rowsArg.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'))
        ) {
          result = {
            callId: call.id,
            ok: false,
            error: {
              code: 'invalid_arguments',
              message: 'rows must be an array of arrays of strings',
            },
          };
        } else {
          const captionArg = call.arguments['caption'];
          const render: RenderIntent = {
            kind: 'table',
            ...(typeof captionArg === 'string' && captionArg.length > 0
              ? { caption: captionArg }
              : {}),
            columns: (columnsArg as string[]).map((header) => ({ header })),
            rows: (rowsArg as string[][]).map((r) => r.map((text) => ({ text }))),
          };
          result = {
            callId: call.id,
            ok: true,
            content:
              'Table shown to the owner. Write only a one-line lead; do not restate the rows.',
            render,
          };
        }
      } else {
        result = {
          callId: call.id,
          ok: false,
          error: { code: 'not_found', message: `Unknown tool: ${call.name}` },
        };
      }

      return result;
    },
  };
}
