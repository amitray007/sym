/**
 * Built-in tools: read_user_profile, set_status, add_reminder.
 *
 * User-identity tools: fetching profile data and mutating the owner's
 * Slack presence (status, reminders). All use actor:'user' for correct
 * token routing. `set_status` is destructive (confirmation required).
 */

import { argError, errMsg } from './_helpers.js';

import type { NameResolver } from '../name-resolver.js';
import type { SlackClient } from '@sym/adapter-slack';
import type { JsonSchema, SlackUserId, ToolCall, ToolDescriptor, ToolResult } from '@sym/contracts';

export const READ_USER_PROFILE_DESCRIPTOR: ToolDescriptor = {
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

export const SET_STATUS_DESCRIPTOR: ToolDescriptor = {
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

export const ADD_REMINDER_DESCRIPTOR: ToolDescriptor = {
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

export async function handleReadUserProfile(
  call: ToolCall,
  slack: SlackClient,
  resolver: NameResolver,
): Promise<ToolResult> {
  const userIdArg = call.arguments['user_id'];
  if (typeof userIdArg !== 'string' || userIdArg.length === 0) {
    return argError(call, 'user_id must be a non-empty string');
  }
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
    return { callId: call.id, ok: true, content: lines.join('\n') };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}

export async function handleSetStatus(call: ToolCall, slack: SlackClient): Promise<ToolResult> {
  const textArg = call.arguments['status_text'];
  const emojiArg = call.arguments['status_emoji'];
  const expiresArg = call.arguments['expires_in_minutes'];
  if (typeof textArg !== 'string') {
    return argError(call, 'status_text must be a string');
  }
  // Resolve expires_in_minutes → unix seconds.
  const expiration =
    typeof expiresArg === 'number' && expiresArg > 0
      ? Math.floor(Date.now() / 1000) + Math.floor(expiresArg * 60)
      : undefined;
  try {
    await slack.usersProfileSet({
      statusText: textArg,
      ...(typeof emojiArg === 'string' && emojiArg.length > 0 ? { statusEmoji: emojiArg } : {}),
      ...(expiration !== undefined ? { statusExpiration: expiration } : {}),
    });
    const summary =
      textArg.length === 0
        ? 'status cleared'
        : `status set to "${textArg}"${typeof emojiArg === 'string' && emojiArg.length > 0 ? ` ${emojiArg}` : ''}${expiration !== undefined ? ` (expires in ${expiresArg as number} min)` : ''}`;
    return { callId: call.id, ok: true, content: summary };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}

export async function handleAddReminder(call: ToolCall, slack: SlackClient): Promise<ToolResult> {
  const textArg = call.arguments['text'];
  const timeArg = call.arguments['time'];
  if (typeof textArg !== 'string' || textArg.length === 0) {
    return argError(call, 'text must be a non-empty string');
  }
  if (typeof timeArg !== 'string' && typeof timeArg !== 'number') {
    return argError(call, 'time must be a string (natural language) or number (unix seconds)');
  }
  try {
    const reminder = await slack.remindersAdd({ text: textArg, time: timeArg });
    const when =
      reminder.time !== undefined ? ` for ${new Date(reminder.time * 1000).toISOString()}` : '';
    return {
      callId: call.id,
      ok: true,
      content: `reminder set${when}: "${reminder.text}" (id ${reminder.id})`,
    };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}
