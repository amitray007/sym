/**
 * Built-in tools: read_channel, read_thread, list_channels.
 *
 * READ tools that fetch conversation history and channel listings from Slack.
 * All three prefer the owner's user token (actor:'user') for broader
 * visibility (private channels + DMs) and fall back to the bot token when
 * the user token isn't configured.
 */

import { argError, clampedLimit, errMsg, formatTranscript } from './_helpers.js';

import type { NameResolver } from '../name-resolver.js';
import type { SlackClient, SlackThreadMessage } from '@sym/adapter-slack';
import type {
  JsonSchema,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from '@sym/contracts';

export const READ_CHANNEL_DESCRIPTOR: ToolDescriptor = {
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

export const READ_THREAD_DESCRIPTOR: ToolDescriptor = {
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

export const LIST_CHANNELS_DESCRIPTOR: ToolDescriptor = {
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

export async function handleReadChannel(
  call: ToolCall,
  slack: SlackClient,
  botUserId: SlackUserId,
  resolver: NameResolver,
): Promise<ToolResult> {
  const channelIdArg = call.arguments['channel_id'];
  if (typeof channelIdArg !== 'string' || channelIdArg.length === 0) {
    return argError(call, 'channel_id must be a non-empty string');
  }
  const limit = clampedLimit(call.arguments['limit'], 30, 1, 100);
  try {
    const { messages } = await slack.conversationsHistory({
      channel: channelIdArg as SlackChannelId,
      limit,
    });
    const transcript = await formatTranscript(messages, botUserId, slack, resolver);
    return { callId: call.id, ok: true, content: transcript };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}

export async function handleReadThread(
  call: ToolCall,
  slack: SlackClient,
  botUserId: SlackUserId,
  resolver: NameResolver,
): Promise<ToolResult> {
  const channelIdArg = call.arguments['channel_id'];
  const threadTsArg = call.arguments['thread_ts'];
  if (typeof channelIdArg !== 'string' || channelIdArg.length === 0) {
    return argError(call, 'channel_id must be a non-empty string');
  }
  if (typeof threadTsArg !== 'string' || threadTsArg.length === 0) {
    return argError(call, 'thread_ts must be a non-empty string');
  }
  try {
    const { messages } = await slack.conversationsReplies({
      channel: channelIdArg as SlackChannelId,
      ts: threadTsArg as SlackThreadTs,
    });
    const transcript = await formatTranscript(
      messages as SlackThreadMessage[],
      botUserId,
      slack,
      resolver,
    );
    return { callId: call.id, ok: true, content: transcript };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}

export async function handleListChannels(
  call: ToolCall,
  slack: SlackClient,
  usedActor: 'bot' | 'user',
  resolver: NameResolver,
): Promise<ToolResult> {
  const limit = clampedLimit(call.arguments['limit'], 50, 1, 200);
  try {
    // When acting as user, include DMs + MPIMs in the visible set.
    const types =
      usedActor === 'user'
        ? 'public_channel,private_channel,mpim,im'
        : 'public_channel,private_channel';
    const { channels } = await slack.conversationsList({
      limit,
      types,
      excludeArchived: true,
    });
    if (channels.length === 0) {
      return { callId: call.id, ok: true, content: '(no channels)' };
    }
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
    return { callId: call.id, ok: true, content: body };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}
