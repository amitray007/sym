import { threadToHistory } from '@sym/adapter-slack';

import type { SlackClient, SlackThreadMessage } from '@sym/adapter-slack';
import type {
  JsonSchema,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
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
 * Format a list of Slack thread messages into a plain-text transcript string.
 * Sym's own posts are prefixed with "Sym:"; all others use threadToHistory's
 * author label (matching the pattern in loadViewedChannelContext in handle-turn.ts).
 */
function formatTranscript(messages: SlackThreadMessage[], botUserId: SlackUserId): string {
  const mapped = threadToHistory(messages, { botUserId });
  if (mapped.length === 0) return '(no messages)';
  return mapped
    .map((m) => (m.role === 'assistant' ? `Sym: ${m.content ?? ''}` : (m.content ?? '')))
    .join('\n');
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
    'Set a Slack reminder for the owner (`reminders.add`). Use when the user asks "remind me to X at Y" / "set a reminder for X tomorrow morning". Slack accepts natural-language time strings ("in 10 minutes", "tomorrow at 9am", "next Tuesday at 3pm") or a unix-seconds timestamp. Low-risk — does NOT require confirmation.',
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
  description:
    'Search across the Slack workspace via `search.messages` — Slack\'s full-workspace search ranked by relevance. Use when the user asks about something that happened somewhere in Slack but you don\'t know which channel/thread (e.g. "find the postgres migration discussion", "who mentioned the Q3 launch plan"). Prefer this over read_channel when the location is unknown. Returns the most relevant matches with permalinks. Slack search modifiers work in the query (e.g. `from:@amit in:#general after:2026-01-01 pricing`).',
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
        description: 'Max results (default 10, max 100).',
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
  LIST_CHANNELS_DESCRIPTOR,
  SEARCH_MESSAGES_DESCRIPTOR,
  POST_AS_OWNER_DESCRIPTOR,
  REACT_AS_OWNER_DESCRIPTOR,
  SET_STATUS_DESCRIPTOR,
  ADD_REMINDER_DESCRIPTOR,
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
            const transcript = formatTranscript(messages, deps.botUserId);
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
            const transcript = formatTranscript(messages, deps.botUserId);
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
              lines.push(`status: ${emoji}${profile.statusText}`);
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
              const res = await fetch(parsed.toString(), {
                signal: controller.signal,
                redirect: 'follow',
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
            const body = channels
              .map((c) => {
                const name = c.name ? `#${c.name}` : '(no name)';
                const priv = c.isPrivate ? ' [private]' : '';
                const members = c.memberCount !== undefined ? ` (${c.memberCount} members)` : '';
                const topic = c.topic ? ` — ${c.topic}` : '';
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
          const rawLimit = typeof limitArg === 'number' ? limitArg : 10;
          const limit = Math.max(1, Math.min(100, rawLimit));
          const sortArg = call.arguments['sort'];
          const sort: 'score' | 'timestamp' = sortArg === 'timestamp' ? 'timestamp' : 'score';
          try {
            const { matches, total } = await slack.searchMessages({
              query: queryArg.trim(),
              count: limit,
              sort,
            });
            if (matches.length === 0) {
              result = { callId: call.id, ok: true, content: '(no matching messages)' };
            } else {
              const header =
                total > matches.length ? `(showing ${matches.length} of ${total} matches)\n` : '';
              const body = matches
                .map((m, i) => {
                  const who = m.username ?? m.userId ?? '(unknown)';
                  const where = m.channelName ? `#${m.channelName}` : m.channelId;
                  const link = m.permalink ? ` <${m.permalink}|link>` : '';
                  const content = m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text;
                  return `${i + 1}. ${who} in ${where}${link}\n   ${content}`;
                })
                .join('\n');
              result = { callId: call.id, ok: true, content: `${header}${body}` };
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              callId: call.id,
              ok: false,
              error: { code: 'execution_failed', message },
            };
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
