import { threadToHistory } from '@sym/adapter-slack';

import type { SlackClient, SlackThreadMessage } from '@sym/adapter-slack';
import type { AppendInput } from '@sym/audit';
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

/** Dependencies required by the built-in dispatcher for Slack read tools. */
export interface BuiltinToolDeps {
  slackClient: SlackClient;
  botUserId: SlackUserId;
  /** Optional audit sink — best-effort; a failure must never block the tool. */
  audit?: (input: AppendInput) => Promise<void>;
}

/**
 * Create the built-in in-process tool dispatcher.
 *
 * Provides: `get_current_time`, `read_channel`, `read_thread`.
 * ctx is unused by built-in tools (no side-effects needing workspace context)
 * but is received for interface conformance.
 */
export function createBuiltinDispatcher(deps: BuiltinToolDeps): ToolDispatcher {
  return {
    list(): ToolDescriptor[] {
      return [GET_CURRENT_TIME_DESCRIPTOR, READ_CHANNEL_DESCRIPTOR, READ_THREAD_DESCRIPTOR];
    },

    async dispatch(call: ToolCall, ctx: ToolRuntimeContext): Promise<ToolResult> {
      // Emit app.tool.call BEFORE execution — best-effort, never blocks dispatch.
      deps
        .audit?.({
          workspaceId: ctx.workspaceId,
          kind: 'app.tool.call',
          actorKind: 'slack_user',
          actorId: ctx.requester,
          targetKind: 'tool',
          payload: { toolName: call.name, callId: call.id },
        })
        .catch((_err: unknown) => {
          /* swallow audit errors */
        });

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
      } else {
        result = {
          callId: call.id,
          ok: false,
          error: { code: 'not_found', message: `Unknown tool: ${call.name}` },
        };
      }

      // Emit app.tool.result AFTER execution — best-effort, never blocks dispatch.
      deps
        .audit?.({
          workspaceId: ctx.workspaceId,
          kind: 'app.tool.result',
          actorKind: 'slack_user',
          actorId: ctx.requester,
          targetKind: 'tool',
          payload: { toolName: call.name, callId: call.id, ok: result.ok },
        })
        .catch((_err: unknown) => {
          /* swallow audit errors */
        });

      return result;
    },
  };
}
