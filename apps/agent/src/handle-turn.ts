import { markdownBlock, receiptToContextBlock, threadToHistory } from '@sym/adapter-slack';
import { ToolRegistry, buildDefaultSoulCascade, runLoop } from '@sym/kernel';

import {
  ensureConversation,
  loadHistory,
  recordAssistantMessage,
  recordUserMessage,
} from './persistence.js';

import type { AppendStreamParams, SlackClient, StartStreamParams } from '@sym/adapter-slack';
import type {
  ChatMessage,
  ProviderInterface,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  Turn,
} from '@sym/contracts';
import type { Database } from '@sym/db';

/** Injected dependencies for processing a turn (the testable seam). */
export interface HandleTurnDeps {
  db: Database;
  provider: ProviderInterface;
  model: string;
  slackClient: SlackClient;
  /** Sym's own bot user id — lets thread history mark its posts as assistant. */
  botUserId: SlackUserId;
  /** Slack team id — required as `recipientTeamId` when streaming into channels. */
  slackTeamId: string;
}

/** Flush a chunk to the stream when the buffer reaches this many characters. */
const FLUSH_CHARS = 60;

/** A channel thread (not a DM) — read the live Slack thread for full context. */
function isChannelThread(
  turn: Turn,
): turn is Turn & { channelId: SlackChannelId; threadTs: SlackThreadTs } {
  return turn.channelId !== undefined && turn.threadTs !== undefined && turn.entrySurface !== 'dm';
}

/**
 * Load the prior context for a turn.
 *
 * Channel threads read the LIVE Slack thread (via conversations.replies) so Sym
 * sees the whole discussion — including messages where it was never @-tagged —
 * excluding the triggering message (the kernel appends that as the current turn).
 * DMs use the DB transcript: every DM message is already a turn, so `messages`
 * holds the full conversation. Both paths are best-effort: on failure we degrade
 * to less context, never block the reply.
 */
async function loadTurnHistory(turn: Turn, deps: HandleTurnDeps): Promise<ChatMessage[]> {
  if (isChannelThread(turn)) {
    try {
      const { messages } = await deps.slackClient.conversationsReplies({
        channel: turn.channelId,
        ts: turn.threadTs,
      });
      return threadToHistory(messages, {
        botUserId: deps.botUserId,
        ...(turn.ts !== undefined ? { excludeTs: turn.ts } : {}),
      });
    } catch (err) {
      console.warn('[agent] thread fetch failed; falling back to DB history:', err);
    }
  }

  try {
    return await loadHistory(deps.db, turn.conversationId);
  } catch (err) {
    console.warn('[agent] loadHistory failed (continuing with no history):', err);
    return [];
  }
}

/** Run a persistence side-effect without ever failing the turn. */
async function persist(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[agent] persist ${label} failed (continuing):`, err);
  }
}

/**
 * Attempt a streamed reply via chat.startStream / appendStream / stopStream.
 * Returns `true` if delivery succeeded, `false` if we should fall back to a
 * normal chat.postMessage (e.g. startStream rejected).
 *
 * The model is run INSIDE this helper — never before — so that on failure we
 * can fall through and let the caller run it on the plain-post path.
 */
async function streamReply(
  turn: Turn,
  deps: HandleTurnDeps,
  ctx: {
    history: ChatMessage[];
    cascade: ReturnType<typeof buildDefaultSoulCascade>;
    registry: ToolRegistry;
  },
): Promise<boolean> {
  const channel = turn.channelId as SlackChannelId;
  const threadTs = turn.threadTs as SlackThreadTs;
  const isAssistant = turn.entrySurface === 'dm';

  // Live status — assistant thread only (setStatus requires an assistant thread).
  if (isAssistant) {
    try {
      await deps.slackClient.assistantThreadsSetStatus({
        channelId: channel,
        threadTs,
        status: 'is thinking…',
      });
    } catch (err) {
      console.warn('[agent] setStatus failed (continuing):', err);
    }
  }

  // Open the stream. If this fails, fall back to a normal post (return false) —
  // do NOT run the model twice.
  const startParams: StartStreamParams = {
    channel,
    threadTs,
    ...(isAssistant ? {} : { recipientUserId: turn.requester, recipientTeamId: deps.slackTeamId }),
  };
  let handle;
  try {
    handle = await deps.slackClient.chatStartStream(startParams);
  } catch (err) {
    console.warn('[agent] startStream failed; falling back to chat.postMessage:', err);
    return false;
  }

  const streamTs = handle.ts;
  let buffer = '';
  const onDelta = async (delta: string): Promise<void> => {
    buffer += delta;
    if (buffer.length >= FLUSH_CHARS) {
      const chunk = buffer;
      buffer = '';
      const appendParams: AppendStreamParams = { channel, ts: streamTs, markdownText: chunk };
      try {
        await deps.slackClient.chatAppendStream(appendParams);
      } catch (err) {
        console.warn('[agent] appendStream failed (continuing):', err);
      }
    }
  };

  const reply = await runLoop(turn, deps.provider, ctx.registry, ctx.cascade, {
    model: deps.model,
    history: ctx.history,
    onDelta,
  });

  if (buffer.length > 0) {
    const appendParams: AppendStreamParams = { channel, ts: streamTs, markdownText: buffer };
    try {
      await deps.slackClient.chatAppendStream(appendParams);
    } catch (err) {
      console.warn('[agent] appendStream (final) failed:', err);
    }
  }

  const receipt = receiptToContextBlock(reply.receipt);
  try {
    await deps.slackClient.chatStopStream({ channel, ts: streamTs, blocks: [receipt] });
  } catch (err) {
    console.warn('[agent] stopStream failed:', err);
  }

  await persist('recordAssistantMessage', () =>
    recordAssistantMessage(deps.db, {
      workspaceId: turn.workspaceId,
      conversationId: turn.conversationId,
      markdown: reply.markdown,
      blocks: [markdownBlock(reply.markdown), receipt],
      slackTs: streamTs,
    }),
  );
  return true;
}

/**
 * The turn path: persist the inbound message, run the kernel loop with prior
 * thread history for context, post the reply to Slack, and persist the reply.
 *
 * Persistence is best-effort — a DB hiccup degrades memory/transcript but never
 * blocks the reply. No tools yet (empty registry), L0 default soul. Deps are
 * injected so this is unit-testable with a fake provider + mock Slack client.
 *
 * Delivery strategy:
 *  - Threaded turns (threadTs defined): attempt streaming; fall back to postMessage.
 *  - Unthreaded turns (slash commands etc.): always postMessage.
 */
export async function handleTurn(turn: Turn, deps: HandleTurnDeps): Promise<void> {
  if (!turn.channelId) {
    console.warn(`[agent] turn ${turn.id} has no channelId; cannot reply`);
    return;
  }

  // Record the conversation + inbound message; load prior history first (so the
  // DB path reflects turns BEFORE this one; the live-thread path excludes it by ts).
  await persist('ensureConversation', () => ensureConversation(deps.db, turn));

  const history = await loadTurnHistory(turn, deps);

  await persist('recordUserMessage', () => recordUserMessage(deps.db, turn));

  const cascade = buildDefaultSoulCascade();
  const registry = new ToolRegistry();

  // Threaded turns: try streaming; fall through to postMessage only if it fails.
  if (turn.threadTs !== undefined) {
    const streamed = await streamReply(turn, deps, { history, cascade, registry });
    if (streamed) return;
  }

  // Non-threaded or stream fallback: run the loop and post normally.
  const reply = await runLoop(turn, deps.provider, registry, cascade, {
    model: deps.model,
    history,
  });

  const blocks = [markdownBlock(reply.markdown), receiptToContextBlock(reply.receipt)];
  const posted = await deps.slackClient.chatPostMessage({
    channel: turn.channelId,
    text: reply.markdown,
    blocks,
    // Reply in-thread when the turn is already threaded; top-level otherwise.
    ...(turn.threadTs !== undefined ? { thread_ts: turn.threadTs } : {}),
  });

  await persist('recordAssistantMessage', () =>
    recordAssistantMessage(deps.db, {
      workspaceId: turn.workspaceId,
      conversationId: turn.conversationId,
      markdown: reply.markdown,
      blocks,
      slackTs: posted.ts,
    }),
  );
}
