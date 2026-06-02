/**
 * Turn-context loaders — fetch the conversation history and any assistant-panel
 * context that should accompany a turn.
 *
 * Reads the Slack thread (or channel history for non-threaded surfaces) and
 * resolves the assistant's viewed-channel context so `handleTurn` can inject
 * both as `ChatMessage` history for the Pi loop.
 */

import { isSlackDmId, isSlackUserId, threadToHistory } from '@sym/adapter-slack';

import type { HandleTurnDeps } from './handle-turn.js';
import type { ChatMessage, SlackChannelId, Turn } from '@sym/contracts';

/** How many recent messages of an un-threaded channel/DM to feed back as history. */
const HISTORY_LIMIT = 20;

/**
 * Default cap for the threaded history path. Matches the default in `config.ts`.
 * Used when `behavior.threadHistoryLimit` is not set.
 */
const THREAD_HISTORY_DEFAULT = 80;

/**
 * Load the prior conversation as `ChatMessage[]` — read LIVE from Slack, which
 * is the only source of truth (there is no transcript store).
 *
 * Threaded turns read the thread via `conversations.replies`; un-threaded turns
 * read recent channel/DM messages via `conversations.history`. Both come back
 * oldest-first from the adapter. The triggering message is excluded by `ts` (the
 * loop appends it as the current turn). Best-effort: any failure degrades to no
 * history, never blocks the reply.
 *
 * The threaded path fetches the entire thread from Slack (no server-side limit),
 * then tail-slices to `behavior.threadHistoryLimit` so a long thread doesn't send
 * hundreds of messages to the model on every turn. The un-threaded path already
 * caps via the `limit` parameter on `conversations.history`.
 */
export async function loadTurnHistory(turn: Turn, deps: HandleTurnDeps): Promise<ChatMessage[]> {
  const channel = turn.channelId;
  if (channel === undefined) return [];
  try {
    let messages;
    let isThreaded = false;
    if (turn.threadTs !== undefined) {
      isThreaded = true;
      ({ messages } = await deps.slackClient.conversationsReplies({
        channel,
        ts: turn.threadTs,
      }));
    } else {
      ({ messages } = await deps.slackClient.conversationsHistory({
        channel,
        limit: HISTORY_LIMIT,
      }));
    }
    let history = threadToHistory(messages, {
      botUserId: deps.botUserId,
      ...(turn.ts !== undefined ? { excludeTs: turn.ts } : {}),
    });

    // Cap the threaded history to the most-recent N messages. The un-threaded
    // path is already server-side capped via `limit` above. A limit of 0 means
    // "no cap" (send everything). The tail is kept so the model always sees the
    // most recent context, not the distant past of a long thread.
    if (isThreaded) {
      const limit = deps.behavior.threadHistoryLimit ?? THREAD_HISTORY_DEFAULT;
      if (limit > 0 && history.length > limit) {
        history = history.slice(history.length - limit);
      }
    }
    // Resolver pass: every history message may still carry raw `<@U…>` /
    // `<#C…>` markup in its body (the prior message text the bot saw in
    // Slack). Strip those before the model sees them — same rationale as
    // for tool returns. Best-effort: a resolver failure logs and falls
    // through to the raw text rather than dropping history entirely.
    return Promise.all(
      history.map(async (m) => {
        if (m.content === undefined || m.content === null || m.content.length === 0) return m;
        try {
          const rewritten = await deps.nameResolver.rewriteMentions(m.content, deps.slackClient);
          return { ...m, content: rewritten };
        } catch {
          return m;
        }
      }),
    );
  } catch (err) {
    console.warn('[agent] history fetch failed (continuing with no history):', err);
    return [];
  }
}

/**
 * Fetch the viewed channel's recent messages as a background `ChatMessage` for
 * assistant-panel turns. Returns `null` if the feature is not applicable (not a
 * DM/assistant turn, no viewed channel known, or viewed channel is the same as
 * the panel channel). Best-effort — any error is logged and swallowed.
 */
export async function loadViewedChannelContext(
  turn: Turn,
  deps: HandleTurnDeps,
): Promise<ChatMessage | null> {
  const viewed = deps.viewedChannelId;
  if (turn.entrySurface !== 'dm' || viewed === undefined || viewed === turn.channelId) return null;
  try {
    const { messages } = await deps.slackClient.conversationsHistory({
      channel: viewed as SlackChannelId,
      limit: 30,
    });
    const mapped = threadToHistory(messages, { botUserId: deps.botUserId });
    if (mapped.length === 0) return null;
    const transcript = mapped
      .map((m) => (m.role === 'assistant' ? `Sym: ${m.content ?? ''}` : (m.content ?? '')))
      .join('\n');
    // Resolve the transcript mentions AND the viewed-channel label so the model
    // gets `#general` / `a direct message with @Name` — never a raw id. The
    // viewed id is a DM when it's a `U…` (the other party's user id, as Slack
    // sometimes reports it) or a `D…` (a real DM channel id we resolve to its
    // counterpart).
    let rewrittenTranscript = transcript;
    let viewedLabel: string;
    try {
      rewrittenTranscript = await deps.nameResolver.rewriteMentions(transcript, deps.slackClient);
      if (isSlackUserId(viewed)) {
        const name = await deps.nameResolver.resolveUser(viewed, deps.slackClient);
        viewedLabel = name !== viewed ? `a direct message with ${name}` : 'a direct message';
      } else if (isSlackDmId(viewed)) {
        const name = await deps.nameResolver.resolveDmParticipant(viewed, deps.slackClient);
        viewedLabel = name !== undefined ? `a direct message with ${name}` : 'a direct message';
      } else {
        const resolvedName = await deps.nameResolver.resolveChannel(viewed, deps.slackClient);
        viewedLabel = resolvedName !== viewed ? `#${resolvedName}` : 'another channel';
      }
    } catch {
      // Never leak the raw id — fall back to a generic, id-free phrase.
      viewedLabel =
        isSlackUserId(viewed) || isSlackDmId(viewed) ? 'a direct message' : 'another channel';
    }
    return {
      role: 'user',
      content: `Background — the user is currently viewing ${viewedLabel} in Slack. Recent messages there:\n${rewrittenTranscript}`,
    };
  } catch (err) {
    console.warn('[agent] viewed-channel context fetch failed (continuing):', err);
    return null;
  }
}
