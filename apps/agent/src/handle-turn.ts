import { markdownBlock, receiptToContextBlock, threadToHistory } from '@sym/adapter-slack';
import { ToolRegistry, runLoop } from '@sym/kernel';

import { createBuiltinDispatcher } from './builtin-tools.js';
import { compositeDispatcher, loadConnectorRegistry } from './connectors.js';
import {
  ensureConversation,
  loadHistory,
  recordAssistantMessage,
  recordUserMessage,
} from './persistence.js';
import { runLoopPi } from './pi/loop.js';
import { buildFireworksModel } from './pi/model.js';
import { loadEnabledSkills } from './skills.js';

import type { AppendStreamParams, SlackClient, StartStreamParams } from '@sym/adapter-slack';
import type { AppendInput } from '@sym/audit';
import type {
  ChatMessage,
  ProviderInterface,
  Reply,
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
  /** The channel the user is currently viewing in Slack's assistant panel, if known. */
  viewedChannelId?: string;
  /** Optional audit sink — best-effort; a failure must never block the turn. */
  audit?: (input: AppendInput) => Promise<void>;
  /**
   * Raw Fireworks credentials for the Pi loop path (`SYM_PI_LOOP=1`).
   * Absent on the kernel path; `runLoopPi` is never called without it.
   */
  fireworks?: { baseUrl: string; apiKey: string };
}

/** `true` when the Pi loop is enabled via env flag. Read once at module load. */
const PI_LOOP_ENABLED = process.env['SYM_PI_LOOP'] === '1';

/** Flush a chunk to the stream when the buffer reaches this many characters. */
const FLUSH_CHARS = 60;

/**
 * Dispatch to the kernel loop or the Pi loop depending on `SYM_PI_LOOP`.
 *
 * Both paths return the same `Reply` shape. `onDelta` and `history` are
 * forwarded identically so the streaming / postMessage pipeline above is
 * completely unchanged.
 */
async function runTurnLoop(
  turn: Turn,
  deps: HandleTurnDeps,
  registry: ToolRegistry,
  history: ChatMessage[],
  onDelta?: (delta: string) => void | Promise<void>,
): Promise<Reply> {
  if (PI_LOOP_ENABLED && deps.fireworks !== undefined) {
    const model = buildFireworksModel({
      baseUrl: deps.fireworks.baseUrl,
      modelId: deps.model,
    });
    const skills = await loadEnabledSkills(deps.db, turn.workspaceId);
    return runLoopPi(
      turn,
      { baseUrl: deps.fireworks.baseUrl, apiKey: deps.fireworks.apiKey, model },
      registry,
      {
        history,
        skills,
        ...(onDelta !== undefined ? { onDelta } : {}),
      },
    );
  }

  return runLoop(turn, deps.provider, registry, {
    model: deps.model,
    history,
    ...(onDelta !== undefined ? { onDelta } : {}),
  });
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

/** Emit a turn-completion audit event — best-effort; never throws into the turn path. */
async function auditTurnComplete(
  audit: HandleTurnDeps['audit'],
  turn: Turn,
  receipt: Reply['receipt'],
): Promise<void> {
  if (!audit) return;
  try {
    await audit({
      workspaceId: turn.workspaceId,
      kind: 'app.turn.complete',
      actorKind: 'slack_user',
      actorId: turn.requester,
      targetKind: 'conversation',
      targetId: turn.conversationId,
      payload: {
        model: receipt.model,
        toolsInvoked: receipt.toolsInvoked,
        ...(receipt.usage !== undefined ? { usage: receipt.usage } : {}),
        ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
        entrySurface: turn.entrySurface,
        ...(turn.channelId !== undefined ? { channelId: turn.channelId } : {}),
      },
    });
  } catch (err) {
    console.warn('[agent] turn audit failed (continuing):', err);
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

  const reply = await runTurnLoop(turn, deps, ctx.registry, ctx.history, onDelta);

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

  await auditTurnComplete(deps.audit, turn, reply.receipt);

  return true;
}

/**
 * Fetch the viewed channel's recent messages as a background `ChatMessage` for
 * assistant-panel turns. Returns `null` if the feature is not applicable (not a
 * DM/assistant turn, no viewed channel known, or viewed channel is the same as
 * the panel channel). Best-effort — any error is logged and swallowed.
 */
async function loadViewedChannelContext(
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
    return {
      role: 'user',
      content: `Background — the user is currently viewing channel ${viewed} in Slack. Recent messages there:\n${transcript}`,
    };
  } catch (err) {
    console.warn('[agent] viewed-channel context fetch failed (continuing):', err);
    return null;
  }
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

  const baseHistory = await loadTurnHistory(turn, deps);
  const viewedContext = await loadViewedChannelContext(turn, deps);
  const history = viewedContext ? [viewedContext, ...baseHistory] : baseHistory;

  await persist('recordUserMessage', () => recordUserMessage(deps.db, turn));

  const builtin = createBuiltinDispatcher({
    slackClient: deps.slackClient,
    botUserId: deps.botUserId,
    ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
  });
  const mcp = await loadConnectorRegistry({
    db: deps.db,
    workspaceId: turn.workspaceId,
    requester: turn.requester,
    ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
  });
  const registry = new ToolRegistry(compositeDispatcher(builtin, mcp));

  try {
    // Threaded turns: try streaming; fall through to postMessage only if it fails.
    if (turn.threadTs !== undefined) {
      const streamed = await streamReply(turn, deps, { history, registry });
      if (streamed) return;
    }

    // Non-threaded or stream fallback: run the loop and post normally.
    const reply = await runTurnLoop(turn, deps, registry, history);

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

    await auditTurnComplete(deps.audit, turn, reply.receipt);
  } finally {
    await mcp?.close().catch(() => {
      /* best-effort: connector close errors must not surface */
    });
  }
}
