import { markdownBlock, receiptToContextBlock, threadToHistory } from '@sym/adapter-slack';
import { ToolRegistry, buildDefaultSoulCascade, runLoop } from '@sym/kernel';

import {
  ensureConversation,
  loadHistory,
  recordAssistantMessage,
  recordUserMessage,
} from './persistence.js';

import type { SlackClient } from '@sym/adapter-slack';
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
}

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
 * The turn path: persist the inbound message, run the kernel loop with prior
 * thread history for context, post the reply to Slack, and persist the reply.
 *
 * Persistence is best-effort — a DB hiccup degrades memory/transcript but never
 * blocks the reply. No tools yet (empty registry), L0 default soul. Deps are
 * injected so this is unit-testable with a fake provider + mock Slack client.
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
