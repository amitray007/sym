import { markdownBlock, receiptToContextBlock, threadToHistory } from '@sym/adapter-slack';
import { ToolRegistry } from '@sym/kernel';

import { createBuiltinDispatcher } from './builtin-tools.js';
import { runLoopPi, nextWhimsicalStatus, WHIMSY_WORDS } from './pi/loop.js';
import { buildFireworksModel } from './pi/model.js';

import type { BehaviorConfig } from './config.js';
import type { AppendStreamParams, SlackClient, StartStreamParams } from '@sym/adapter-slack';
import type {
  ChatMessage,
  Reply,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  Turn,
} from '@sym/contracts';

/** Injected dependencies for processing a turn (the testable seam). */
export interface HandleTurnDeps {
  /** Raw Fireworks credentials — required by the Pi loop. */
  fireworks: { baseUrl: string; apiKey: string };
  model: string;
  slackClient: SlackClient;
  /** Sym's own bot user id — lets thread history mark its posts as assistant. */
  botUserId: SlackUserId;
  /** Slack team id — required as `recipientTeamId` when streaming into channels. */
  slackTeamId: string;
  /** The channel the user is currently viewing in Slack's assistant panel, if known. */
  viewedChannelId?: string;
  /** Runtime behavior knobs. */
  behavior: BehaviorConfig;
}

/** Flush a chunk to the stream when the buffer reaches this many characters. */
const FLUSH_CHARS = 60;

/** How many recent messages of an un-threaded channel/DM to feed back as history. */
const HISTORY_LIMIT = 20;

/**
 * Slack's `assistant.threads.setStatus` shimmer auto-clears after 2 min. Re-send
 * the most recent status every 90s so long tool runs keep showing feedback.
 */
const STATUS_KEEPALIVE_MS = 90_000;

/** Minimum ms the task card stays visible before delete/collapse runs. */
const MIN_CARD_DISPLAY_MS = 800;

/**
 * Manages the live task card — a separate Slack message that tracks tool
 * execution steps in real time. Appears when enough tools fire (threshold),
 * then either deleted or collapsed to a summary line after the turn.
 *
 * All Slack calls are best-effort: any error is logged and swallowed so a
 * card failure never blocks reply delivery.
 */
class TaskCardManager {
  private cardTs: SlackThreadTs | undefined;
  private completedLabels: string[] = [];
  private currentLabel: string | undefined;
  private toolCount = 0;
  private readonly startMs = Date.now();

  constructor(
    private readonly channel: SlackChannelId,
    private readonly threadTs: SlackThreadTs,
    private readonly slackClient: SlackClient,
    /** Tool calls before the card appears (0 = always show from first tool). */
    private readonly threshold: number,
    private readonly after: 'delete' | 'collapse',
  ) {}

  async onToolStart(friendlyLabel: string): Promise<void> {
    this.toolCount++;

    // Mark previous step done, set new current.
    if (this.currentLabel !== undefined) {
      this.completedLabels.push(this.currentLabel);
    }
    this.currentLabel = friendlyLabel;

    if (this.toolCount < this.threshold) return;

    if (this.cardTs === undefined) {
      await this.postCard();
    } else {
      await this.updateCard();
    }
  }

  async finish(): Promise<void> {
    if (this.cardTs === undefined) return;

    if (this.currentLabel !== undefined) {
      this.completedLabels.push(this.currentLabel);
      this.currentLabel = undefined;
    }

    // Ensure the card is visible for at least MIN_CARD_DISPLAY_MS.
    const elapsed = Date.now() - this.startMs;
    if (elapsed < MIN_CARD_DISPLAY_MS) {
      await new Promise((r) => setTimeout(r, MIN_CARD_DISPLAY_MS - elapsed));
    }

    try {
      if (this.after === 'collapse') {
        const secs = ((Date.now() - this.startMs) / 1000).toFixed(1);
        await this.slackClient.chatUpdate({
          channel: this.channel,
          ts: this.cardTs!,
          text: `✅ ${this.completedLabels.length} steps · ${secs}s`,
          blocks: [
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `✅ ${this.completedLabels.length} steps · ${secs}s`,
                },
              ],
            },
          ],
        });
      } else {
        await this.slackClient.chatDelete({ channel: this.channel, ts: this.cardTs! });
      }
    } catch (err) {
      console.warn('[agent] task card finish failed (continuing):', err);
    }
  }

  private cardText(): string {
    const done = this.completedLabels.map((l) => `✅ ${capitalize(l)}`).join('\n');
    const current = this.currentLabel !== undefined ? `\n⏳ ${capitalize(this.currentLabel)}…` : '';
    return `${done}${current}`.trimStart();
  }

  private async postCard(): Promise<void> {
    try {
      const result = await this.slackClient.chatPostMessage({
        channel: this.channel,
        text: this.cardText(),
        thread_ts: this.threadTs,
      });
      this.cardTs = result.ts;
    } catch (err) {
      console.warn('[agent] task card post failed (continuing):', err);
    }
  }

  private async updateCard(): Promise<void> {
    if (this.cardTs === undefined) return;
    try {
      await this.slackClient.chatUpdate({
        channel: this.channel,
        ts: this.cardTs,
        text: this.cardText(),
      });
    } catch (err) {
      console.warn('[agent] task card update failed (continuing):', err);
    }
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Run the turn through the Pi loop.
 *
 * Single path — no fallback. `onDelta` and `history` are forwarded so the
 * streaming / postMessage pipeline is unchanged.
 */
async function runTurnLoop(
  turn: Turn,
  deps: HandleTurnDeps,
  registry: ToolRegistry,
  history: ChatMessage[],
  onDelta?: (delta: string) => void | Promise<void>,
  onStatus?: (status: string) => void | Promise<void>,
  onToolStart?: (friendlyLabel: string) => void | Promise<void>,
): Promise<Reply> {
  const model = buildFireworksModel({
    baseUrl: deps.fireworks.baseUrl,
    modelId: deps.model,
  });
  return runLoopPi(
    turn,
    { baseUrl: deps.fireworks.baseUrl, apiKey: deps.fireworks.apiKey, model },
    registry,
    {
      history,
      slackClient: deps.slackClient,
      ...(onDelta !== undefined ? { onDelta } : {}),
      ...(onStatus !== undefined ? { onStatus } : {}),
      ...(onToolStart !== undefined ? { onToolStart } : {}),
    },
  );
}

/**
 * Load the prior conversation as `ChatMessage[]` — read LIVE from Slack, which
 * is the only source of truth (there is no transcript store).
 *
 * Threaded turns read the thread via `conversations.replies`; un-threaded turns
 * read recent channel/DM messages via `conversations.history`. Both come back
 * oldest-first from the adapter. The triggering message is excluded by `ts` (the
 * loop appends it as the current turn). Best-effort: any failure degrades to no
 * history, never blocks the reply.
 */
async function loadTurnHistory(turn: Turn, deps: HandleTurnDeps): Promise<ChatMessage[]> {
  const channel = turn.channelId;
  if (channel === undefined) return [];
  try {
    if (turn.threadTs !== undefined) {
      const { messages } = await deps.slackClient.conversationsReplies({
        channel,
        ts: turn.threadTs,
      });
      return threadToHistory(messages, {
        botUserId: deps.botUserId,
        ...(turn.ts !== undefined ? { excludeTs: turn.ts } : {}),
      });
    }
    const { messages } = await deps.slackClient.conversationsHistory({
      channel,
      limit: HISTORY_LIMIT,
    });
    return threadToHistory(messages, {
      botUserId: deps.botUserId,
      ...(turn.ts !== undefined ? { excludeTs: turn.ts } : {}),
    });
  } catch (err) {
    console.warn('[agent] history fetch failed (continuing with no history):', err);
    return [];
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

  // Track the most recent status so the keepalive interval can re-send it.
  // `phaseUpdated` flips true the first time we see a concrete phase string
  // (tool verb or "writing the reply") — that signal lets the keepalive choose
  // between rotating whimsy ("is wadoodling…") and re-sending the real phase.
  let lastStatus = 'is thinking…';
  let phaseUpdated = false;
  // Recognise whimsy phrases so they don't trip the "real phase fired" flag.
  const whimsyPhrases = new Set(WHIMSY_WORDS.map((w) => `is ${w}…`));
  const sendStatus = async (status: string): Promise<void> => {
    lastStatus = status;
    if (status !== 'is thinking…' && status !== '' && !whimsyPhrases.has(status)) {
      phaseUpdated = true;
    }
    try {
      await deps.slackClient.assistantThreadsSetStatus({
        channelId: channel,
        threadTs,
        status,
      });
    } catch (err) {
      console.warn('[agent] setStatus failed (continuing):', err);
    }
  };

  // Live status — now safe for channel @-mentions too (per Slack's 2026-03-05
  // changelog, setStatus works in channel threads with chat:write scope).
  await sendStatus('is thinking…');

  // Keepalive — Slack auto-clears the shimmer after 2 min, so re-send the latest
  // status every 90s. If no real phase has fired yet, rotate through whimsical
  // "still thinking" words so the shimmer feels alive on long turns. If a phase
  // has fired ("is reading the thread…"), re-send it verbatim — don't override
  // real phase info with whimsy.
  let whimsyTick = 0;
  const keepaliveTimer = setInterval(() => {
    if (phaseUpdated) {
      void sendStatus(lastStatus);
    } else {
      void sendStatus(nextWhimsicalStatus(++whimsyTick));
    }
  }, STATUS_KEEPALIVE_MS);

  // Task card — slash commands always show from tool #1; other surfaces use
  // the configured threshold. Threshold of 0 disables the card entirely.
  const cardThreshold = turn.entrySurface === 'slash_command' ? 1 : deps.behavior.taskCardThreshold;
  const taskCard =
    cardThreshold > 0
      ? new TaskCardManager(
          channel,
          threadTs,
          deps.slackClient,
          cardThreshold,
          deps.behavior.taskCardAfter,
        )
      : null;

  try {
    // Lazy stream open — Slack's chat.startStream creates an empty message that
    // shows its own "Thinking..." placeholder until first append. That competes
    // with our setStatus shimmer. Defer startStream until we have real reply
    // tokens; until then, only the shimmer is visible.
    const startParams: StartStreamParams = {
      channel,
      threadTs,
      ...(isAssistant
        ? {}
        : { recipientUserId: turn.requester, recipientTeamId: deps.slackTeamId }),
    };
    let streamTs: SlackThreadTs | undefined;
    let streamOpenFailed = false;
    let buffer = '';

    const ensureStreamOpen = async (): Promise<boolean> => {
      if (streamTs !== undefined) return true;
      if (streamOpenFailed) return false;
      try {
        const handle = await deps.slackClient.chatStartStream(startParams);
        streamTs = handle.ts;
        return true;
      } catch (err) {
        console.warn('[agent] startStream failed; will fall back to postMessage:', err);
        streamOpenFailed = true;
        return false;
      }
    };

    const flushBuffer = async (): Promise<void> => {
      if (buffer.length === 0 || streamTs === undefined) return;
      const chunk = buffer;
      buffer = '';
      const appendParams: AppendStreamParams = { channel, ts: streamTs, markdownText: chunk };
      try {
        await deps.slackClient.chatAppendStream(appendParams);
      } catch (err) {
        console.warn('[agent] appendStream failed (continuing):', err);
      }
    };

    const onDelta = async (delta: string): Promise<void> => {
      if (delta.length === 0) return;
      // Open the stream on the FIRST real delta — Slack's empty-stream
      // "Thinking..." placeholder never shows.
      if (!(await ensureStreamOpen())) return;
      buffer += delta;
      if (buffer.length < FLUSH_CHARS) return;
      await flushBuffer();
    };

    const onToolStart = async (friendlyLabel: string): Promise<void> => {
      await taskCard?.onToolStart(friendlyLabel);
    };

    const reply = await runTurnLoop(
      turn,
      deps,
      ctx.registry,
      ctx.history,
      onDelta,
      sendStatus,
      onToolStart,
    );

    // Settle the task card before or alongside reply delivery.
    await taskCard?.finish();

    // Reply produced no streamed deltas (empty/very-short reply, or only tool
    // calls). Either way, we never opened the stream — post normally so the
    // user sees the answer instead of nothing.
    if (streamTs === undefined) {
      const blocks = [markdownBlock(reply.markdown), receiptToContextBlock(reply.receipt)];
      await deps.slackClient.chatPostMessage({
        channel,
        text: reply.markdown,
        blocks,
        thread_ts: threadTs,
      });
      return true;
    }

    // Final flush + close.
    await flushBuffer();
    const receipt = receiptToContextBlock(reply.receipt);
    try {
      await deps.slackClient.chatStopStream({ channel, ts: streamTs, blocks: [receipt] });
    } catch (err) {
      console.warn('[agent] stopStream failed:', err);
    }

    return true;
  } finally {
    clearInterval(keepaliveTimer);
    // Explicitly clear the shimmer — Slack only auto-clears setStatus on
    // chat.postMessage, NOT on chat.stopStream, so a streamed reply leaves
    // the "is …" line stuck until the 2-min timeout. Belt-and-braces: also
    // runs on the postMessage-fallback path (harmless; the post clears too).
    try {
      await deps.slackClient.assistantThreadsSetStatus({
        channelId: channel,
        threadTs,
        status: '',
      });
    } catch (err) {
      console.warn('[agent] setStatus clear failed:', err);
    }
  }
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
 * The turn path: read live Slack history for context, run the Pi loop with the
 * built-in tools, and deliver the reply to Slack.
 *
 * Stateless — Slack is the only memory; nothing is persisted. Deps are injected
 * so this is unit-testable with a mocked Pi loop + a mock Slack client.
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

  const baseHistory = await loadTurnHistory(turn, deps);
  const viewedContext = await loadViewedChannelContext(turn, deps);
  const history = viewedContext ? [viewedContext, ...baseHistory] : baseHistory;

  const builtin = createBuiltinDispatcher({
    slackClient: deps.slackClient,
    botUserId: deps.botUserId,
  });
  const registry = new ToolRegistry(builtin);

  // Threaded turns: try streaming; fall through to postMessage only if it fails.
  if (turn.threadTs !== undefined) {
    const streamed = await streamReply(turn, deps, { history, registry });
    if (streamed) return;
  }

  // Non-threaded or stream fallback: run the loop and post normally.
  const reply = await runTurnLoop(turn, deps, registry, history);

  const blocks = [markdownBlock(reply.markdown), receiptToContextBlock(reply.receipt)];
  await deps.slackClient.chatPostMessage({
    channel: turn.channelId,
    text: reply.markdown,
    blocks,
    // Reply in-thread when the turn is already threaded; top-level otherwise.
    ...(turn.threadTs !== undefined ? { thread_ts: turn.threadTs } : {}),
  });
}
