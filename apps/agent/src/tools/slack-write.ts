/**
 * Built-in tools: post_as_owner, react_as_owner, delete_message.
 *
 * Write tools that mutate Slack on behalf of the owner or Sym itself.
 * `post_as_owner` and `react_as_owner` use the owner's user token
 * (actor:'user', destructive — requires confirmation). `delete_message`
 * acts as the bot (removes Sym's own messages; also destructive).
 */

import { argError, errMsg } from './_helpers.js';

import type { SlackClient } from '@sym/adapter-slack';
import type {
  JsonSchema,
  SlackChannelId,
  SlackThreadTs,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Phase B — Act-as-owner write tools (user-token only)
// ---------------------------------------------------------------------------
//
// These tools use the owner's user token so the action shows up in Slack as
// being performed by the owner, not by Sym. Destructive ones ride the
// existing beforeToolCall confirmation flow (pi/loop.ts) — the owner must
// approve via a Slack button before they execute.

export const POST_AS_OWNER_DESCRIPTOR: ToolDescriptor = {
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

export const REACT_AS_OWNER_DESCRIPTOR: ToolDescriptor = {
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

export const DELETE_MESSAGE_DESCRIPTOR: ToolDescriptor = {
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

export async function handlePostAsOwner(
  call: ToolCall,
  slack: SlackClient,
  ownerPostMarker?: boolean,
): Promise<ToolResult> {
  const channelArg = call.arguments['channel_id'];
  const textArg = call.arguments['text'];
  const threadTsArg = call.arguments['thread_ts'];
  if (typeof channelArg !== 'string' || channelArg.length === 0) {
    return argError(call, 'channel_id must be a non-empty string');
  }
  if (typeof textArg !== 'string' || textArg.length === 0) {
    return argError(call, 'text must be a non-empty string');
  }
  // Optional transparency marker — disabled via OWNER_POST_MARKER=false.
  const body = ownerPostMarker === true ? `${textArg}\n_(via Sym)_` : textArg;
  try {
    const posted = await slack.chatPostMessage({
      channel: channelArg as SlackChannelId,
      text: body,
      ...(typeof threadTsArg === 'string' && threadTsArg.length > 0
        ? { thread_ts: threadTsArg as SlackThreadTs }
        : {}),
    });
    return {
      callId: call.id,
      ok: true,
      content: `posted as owner to ${channelArg} at ${posted.ts}`,
    };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}

export async function handleReactAsOwner(call: ToolCall, slack: SlackClient): Promise<ToolResult> {
  const channelArg = call.arguments['channel_id'];
  const tsArg = call.arguments['message_ts'];
  const emojiArg = call.arguments['emoji'];
  if (typeof channelArg !== 'string' || channelArg.length === 0) {
    return argError(call, 'channel_id must be a non-empty string');
  }
  if (typeof tsArg !== 'string' || tsArg.length === 0) {
    return argError(call, 'message_ts must be a non-empty string');
  }
  if (typeof emojiArg !== 'string' || emojiArg.length === 0) {
    return argError(call, 'emoji must be a non-empty string');
  }
  // Strip any leading/trailing colons the model might add habitually.
  const name = emojiArg.replace(/^:|:$/g, '');
  try {
    await slack.reactionsAdd({
      channel: channelArg as SlackChannelId,
      timestamp: tsArg as SlackThreadTs,
      name,
    });
    return {
      callId: call.id,
      ok: true,
      content: `reacted :${name}: as owner on ${channelArg}/${tsArg}`,
    };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}

export async function handleDeleteMessage(call: ToolCall, slack: SlackClient): Promise<ToolResult> {
  const channelArg = call.arguments['channel_id'];
  const tsArg = call.arguments['message_ts'];
  if (typeof channelArg !== 'string' || channelArg.length === 0) {
    return argError(call, 'channel_id must be a non-empty string');
  }
  if (typeof tsArg !== 'string' || tsArg.length === 0) {
    return argError(call, 'message_ts must be a non-empty string');
  }
  try {
    // Bot-token delete — `slack` is the bot client (delete_message has
    // no actor:'user', so pickClient returned it). Slack only permits
    // deleting messages this bot authored.
    await slack.chatDelete({
      channel: channelArg as SlackChannelId,
      ts: tsArg as SlackThreadTs,
    });
    return {
      callId: call.id,
      ok: true,
      content: `deleted Sym's message ${tsArg} in ${channelArg}`,
    };
  } catch (err: unknown) {
    // Slack returns `cant_delete_message` / `message_not_found` when the
    // target isn't Sym's own message (or it's already gone). Surface the
    // raw Slack reason plus the one constraint the model can act on.
    const reason = errMsg(err);
    return {
      callId: call.id,
      ok: false,
      error: {
        code: 'execution_failed',
        message: `${reason} — Sym can only delete messages it posted itself.`,
      },
    };
  }
}
