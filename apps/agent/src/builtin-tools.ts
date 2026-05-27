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
  // READ tool: the model supplies channel_id from user-visible mentions like <#C0123|name>.
  // Slack's bot-membership gate bounds what channels are actually readable.
  // Side-effect tools (a later chunk) will take their target from ToolRuntimeContext instead.
  description:
    "Read the most recent messages of a Slack channel (oldest-first). Use to catch up on or summarize a channel other than the current one. `channel_id` is a Slack channel ID like C0123 (the model can read it from a `<#C0123|name>` mention in the user's message). Sym can only read channels it is a member of.",
  parameters: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Slack channel ID, e.g. C0123',
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
};

const READ_THREAD_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'read_thread',
  // READ tool: model supplies both channel_id and thread_ts from context.
  // Same membership-gate constraint as read_channel applies.
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
};

const SEARCH_MESSAGES_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'search_messages',
  // READ tool: free-text search across Slack messages visible to the bot.
  description:
    'Search Slack messages workspace-wide by query. Returns matches with channel, author, ts, text, and permalink. Use to find prior conversations on a topic. Supports Slack search modifiers like `in:#channel`, `from:@user`, `after:2026-01-01`.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Slack search query (supports `in:`, `from:`, `after:`, etc.)',
      },
      count: {
        type: 'number',
        description: 'Max matches (default 10, max 20)',
      },
      sort: {
        type: 'string',
        enum: ['timestamp', 'score'],
        description: '`score` (default, relevance) or `timestamp` (newest-first)',
      },
    },
    required: ['query'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

const READ_USER_PROFILE_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'read_user_profile',
  // READ tool: model supplies user_id from <@U0123> mentions or search results.
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
  // READ tool: surfaces channels the bot's token can see (membership-bounded for private).
  description:
    'List Slack channels the bot can see (public + private channels it belongs to). Returns id, name, topic, is_private, member_count. Use to discover channel IDs before calling read_channel.',
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

/** Dependencies required by the built-in dispatcher for Slack read tools. */
export interface BuiltinToolDeps {
  slackClient: SlackClient;
  botUserId: SlackUserId;
}

/**
 * Create the built-in in-process tool dispatcher.
 *
 * Provides: `get_current_time`, `read_channel`, `read_thread`,
 * `search_messages`, `read_user_profile`, `fetch_url`, `list_channels`.
 * ctx is unused by built-in tools (no side-effects needing workspace context)
 * but is received for interface conformance.
 */
export function createBuiltinDispatcher(deps: BuiltinToolDeps): ToolDispatcher {
  return {
    list(): ToolDescriptor[] {
      return [
        GET_CURRENT_TIME_DESCRIPTOR,
        READ_CHANNEL_DESCRIPTOR,
        READ_THREAD_DESCRIPTOR,
        SEARCH_MESSAGES_DESCRIPTOR,
        READ_USER_PROFILE_DESCRIPTOR,
        FETCH_URL_DESCRIPTOR,
        LIST_CHANNELS_DESCRIPTOR,
      ];
    },

    async dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> {
      let result: ToolResult;

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
            const { messages } = await deps.slackClient.conversationsHistory({
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
            const { messages } = await deps.slackClient.conversationsReplies({
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
      } else if (call.name === 'search_messages') {
        const queryArg = call.arguments['query'];
        if (typeof queryArg !== 'string' || queryArg.length === 0) {
          result = {
            callId: call.id,
            ok: false,
            error: { code: 'invalid_arguments', message: 'query must be a non-empty string' },
          };
        } else {
          const countArg = call.arguments['count'];
          const rawCount = typeof countArg === 'number' ? countArg : 10;
          const count = Math.max(1, Math.min(20, rawCount));
          const sortArg = call.arguments['sort'];
          const sort: 'timestamp' | 'score' =
            sortArg === 'timestamp' || sortArg === 'score' ? sortArg : 'score';

          try {
            const { matches, total } = await deps.slackClient.searchMessages({
              query: queryArg,
              count,
              sort,
            });
            if (matches.length === 0) {
              result = {
                callId: call.id,
                ok: true,
                content: `(no matches for "${queryArg}")`,
              };
            } else {
              const header = `${matches.length} of ${total} match(es) for "${queryArg}":`;
              const body = matches
                .map((m) => {
                  const who = m.username ?? m.user ?? '(unknown)';
                  const where = m.channelName ? `#${m.channelName}` : m.channelId;
                  const link = m.permalink ? ` ${m.permalink}` : '';
                  return `- [${where}] ${who} @ ${m.ts}: ${m.text}${link}`;
                })
                .join('\n');
              result = { callId: call.id, ok: true, content: `${header}\n${body}` };
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
            const profile = await deps.slackClient.usersInfo({ user: userIdArg as SlackUserId });
            const lines: string[] = [`id: ${profile.id}`];
            if (profile.displayName) lines.push(`display_name: ${profile.displayName}`);
            if (profile.realName) lines.push(`real_name: ${profile.realName}`);
            if (profile.title) lines.push(`title: ${profile.title}`);
            // Email is only present when the bot has the `users:read.email` scope.
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
          const { channels } = await deps.slackClient.conversationsList({
            limit,
            types: 'public_channel,private_channel',
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
