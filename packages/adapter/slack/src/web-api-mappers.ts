import type { SlackChannelSummary, SlackThreadMessage, SlackUserProfile } from './types.js';
import type { SlackChannelId, SlackUserId } from '@sym/contracts';

/**
 * Pure response-mapping helpers shared by `WebApiSlackClient` methods.
 * Nothing here touches `fetch` or the bot token — these are only called by
 * the class methods after the API response has been received.
 */

// ---------------------------------------------------------------------------
// Raw Slack response shapes (used by both replies + history paginators)
// ---------------------------------------------------------------------------

/**
 * Minimal raw message row returned by both `conversations.replies` and
 * `conversations.history`. The two endpoints use the same field names.
 */
export interface SlackRawMessageRow {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  subtype?: string;
}

/**
 * Minimal raw paginated response — shared base for both endpoints so we don't
 * duplicate the type definition.
 */
export interface SlackPagedResponse {
  ok: boolean;
  error?: string;
  messages?: SlackRawMessageRow[];
  response_metadata?: { next_cursor?: string };
}

// ---------------------------------------------------------------------------
// Message-row mapper
// ---------------------------------------------------------------------------

/**
 * Map a single raw Slack message row into a `SlackThreadMessage`.
 * Pure — no `this`, no side effects. Used identically in
 * `conversationsReplies` and `conversationsHistory`.
 */
export function mapMessageRow(m: SlackRawMessageRow): SlackThreadMessage {
  return {
    ...(m.user !== undefined ? { user: m.user as SlackUserId } : {}),
    ...(m.bot_id !== undefined ? { botId: m.bot_id } : {}),
    text: m.text ?? '',
    ts: (m.ts ?? '') as SlackThreadMessage['ts'],
    ...(m.subtype !== undefined ? { subtype: m.subtype } : {}),
  };
}

// ---------------------------------------------------------------------------
// User-profile mapper
// ---------------------------------------------------------------------------

/**
 * Raw user-profile fields that both `users.info` and `users.list` return.
 * The outer shape is slightly different per endpoint, but the profile sub-object
 * and top-level scalar fields are identical — so we share the mapper.
 */
export interface SlackRawUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  tz?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    title?: string;
    email?: string;
    status_text?: string;
    status_emoji?: string;
  };
}

/**
 * Map a raw Slack user object into a `SlackUserProfile`.
 * Pure — no `this`, no side effects. Used identically in
 * `usersInfo` and `usersList`.
 *
 * @throws Never — caller throws `SlackWebApiError` on missing `id` before calling this.
 */
export function mapUserProfile(u: SlackRawUser & { id: string }): SlackUserProfile {
  const p = u.profile ?? {};
  return {
    id: u.id as SlackUserId,
    ...(u.name !== undefined && u.name !== '' ? { userName: u.name } : {}),
    ...(p.display_name !== undefined && p.display_name !== ''
      ? { displayName: p.display_name }
      : {}),
    ...(p.real_name !== undefined || u.real_name !== undefined
      ? { realName: (p.real_name ?? u.real_name) as string }
      : {}),
    ...(p.title !== undefined && p.title !== '' ? { title: p.title } : {}),
    // Email only present when the bot has the `users:read.email` scope.
    ...(p.email !== undefined && p.email !== '' ? { email: p.email } : {}),
    ...(p.status_text !== undefined && p.status_text !== ''
      ? { statusText: p.status_text, status: p.status_text }
      : {}),
    ...(p.status_emoji !== undefined && p.status_emoji !== ''
      ? { statusEmoji: p.status_emoji }
      : {}),
    ...(u.tz !== undefined ? { tz: u.tz } : {}),
    ...(u.is_bot !== undefined ? { isBot: u.is_bot } : {}),
    ...(u.deleted !== undefined ? { deleted: u.deleted } : {}),
  };
}

// ---------------------------------------------------------------------------
// Channel-summary mapper
// ---------------------------------------------------------------------------

/**
 * Raw channel row returned by `conversations.list`.
 */
export interface SlackRawChannel {
  id?: string;
  name?: string;
  is_private?: boolean;
  topic?: { value?: string };
  num_members?: number;
}

/**
 * Map a raw Slack channel row into a `SlackChannelSummary`.
 * Pure — no `this`, no side effects.
 *
 * @throws Never — caller filters out rows with missing `id` before calling this.
 */
export function mapChannelSummary(c: SlackRawChannel & { id: string }): SlackChannelSummary {
  return {
    id: c.id as SlackChannelId,
    ...(c.name !== undefined ? { name: c.name } : {}),
    isPrivate: c.is_private === true,
    ...(c.topic?.value !== undefined && c.topic.value !== '' ? { topic: c.topic.value } : {}),
    ...(c.num_members !== undefined ? { memberCount: c.num_members } : {}),
  };
}
