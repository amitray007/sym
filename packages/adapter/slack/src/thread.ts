import type { SlackThreadMessage } from './client.js';
import type { ChatMessage, SlackThreadTs, SlackUserId } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Slack thread → kernel history
//
// `conversations.replies` hands back the whole thread (root + every reply,
// including messages where Sym was never tagged). This turns that raw thread
// into the `ChatMessage[]` the kernel feeds the model as prior context.
// Pure: no I/O, deterministic, unit-tested in isolation.
// ---------------------------------------------------------------------------

/** Slack message subtypes that are membership/admin noise, not conversation. */
const NOISE_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
]);

/** Default cap on thread messages handed to the model (root + most recent). */
const DEFAULT_MAX_MESSAGES = 40;

export interface ThreadToHistoryOpts {
  /** Sym's own bot user id — its posts map to the `assistant` role. */
  botUserId: SlackUserId;
  /**
   * Drop the message with this `ts`. Used to exclude the triggering mention,
   * which the kernel appends separately as the current turn (avoids a dupe).
   */
  excludeTs?: SlackThreadTs;
  /** Optional display-name lookup for author labels; falls back to the raw id. */
  names?: Record<string, string>;
  /** Max messages to keep; preserves the root + the most recent. */
  maxMessages?: number;
}

/** Strip a leading `<@U…>` mention from thread text (mirrors normalize). */
function stripLeadingMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/u, '').trim();
}

/** Human-readable author label: display name if known, else the raw id. */
function authorLabel(m: SlackThreadMessage, names?: Record<string, string>): string {
  if (m.user !== undefined) return names?.[m.user] ?? m.user;
  if (m.botId !== undefined) return names?.[m.botId] ?? m.botId;
  return 'unknown';
}

/** Keep the first (root) message + the most recent, capped at `max` total. */
function trimKeepingRoot(items: SlackThreadMessage[], max: number): SlackThreadMessage[] {
  if (items.length <= max) return items;
  const root = items[0];
  const recent = items.slice(items.length - (max - 1));
  return root !== undefined ? [root, ...recent] : recent;
}

/**
 * Convert a fetched Slack thread into kernel `ChatMessage[]` for use as history.
 *
 * - Sym's own posts → `assistant`; everyone else → `user`, prefixed with an
 *   author label so multi-party threads stay legible to the model.
 * - Membership/admin noise, the triggering message (`excludeTs`), and
 *   empty/mention-only messages are dropped.
 * - Trimmed to `maxMessages`, preserving the root message + most recent.
 */
export function threadToHistory(
  messages: SlackThreadMessage[],
  opts: ThreadToHistoryOpts,
): ChatMessage[] {
  const kept = messages.filter((m) => {
    if (opts.excludeTs !== undefined && m.ts === opts.excludeTs) return false;
    if (m.subtype !== undefined && NOISE_SUBTYPES.has(m.subtype)) return false;
    return stripLeadingMention(m.text).length > 0;
  });

  return trimKeepingRoot(kept, opts.maxMessages ?? DEFAULT_MAX_MESSAGES).map((m) => {
    const text = stripLeadingMention(m.text);
    if (m.user !== undefined && m.user === opts.botUserId) {
      return { role: 'assistant', content: text };
    }
    return { role: 'user', content: `${authorLabel(m, opts.names)}: ${text}` };
  });
}
