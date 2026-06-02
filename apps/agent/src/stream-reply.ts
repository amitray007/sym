import {
  markdownBlocks,
  receiptToContextBlock,
  renderIntentToBlocks,
  renderIntentToFallbackText,
} from '@sym/adapter-slack';

import { logCtx } from './log.js';
import { runLoopPi } from './pi/loop.js';
import { buildFireworksModel } from './pi/model.js';
import { pickThinkingLevel } from './pi/think-router.js';
import { cleanupReply } from './reply-cleanup.js';
import { TaskCardManager } from './task-card-manager.js';
import {
  nextWhimsicalStatus,
  pickShimmerPhrase,
  pickShimmerStatus,
  WHIMSY_WORDS,
} from './thinking-copy.js';

import type { HandleTurnDeps } from './handle-turn.js';
import type { PlanController } from './plan-controller.js';
import type {
  AppendStreamParams,
  SlackBlock,
  StartStreamParams,
  TaskUpdateChunk,
} from '@sym/adapter-slack';
import type { ChatMessage, Reply, SlackChannelId, SlackThreadTs, Turn } from '@sym/contracts';
import type { ToolRegistry } from '@sym/kernel';

/** Flush a chunk to the stream when the buffer reaches this many characters. */
const FLUSH_CHARS = 60;

/**
 * Default per-turn deadline used when `SYM_TURN_DEADLINE_MS` is not set via
 * `BehaviorConfig`. Matches the default in `config.ts`.
 */
const DEFAULT_TURN_DEADLINE_MS = 60_000;

/**
 * Slack's `assistant.threads.setStatus` shimmer auto-clears after 2 min. Re-send
 * the most recent status every 90s so long tool runs keep showing feedback.
 */
const STATUS_KEEPALIVE_MS = 90_000;

/** Cap the notification/fallback `text` param under Slack's ~40k limit. */
export function clipNotif(text: string): string {
  const MAX = 39_000;
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

/**
 * Whether to run the LLM cleanup backstop. The model narrates its STEPS
 * whenever it's doing things, so narration tracks *any* tool use — not the tool
 * COUNT. (Observed 2026-05-30: a turn that narrated a whole fake p1/p2/p3 plan
 * while actually invoking just `get_current_time` slipped past a `> 1` gate.)
 * Run whenever a plan was set OR at least one tool ran. Pure no-tool text
 * replies ("hello") have nothing to narrate, so they skip the extra call. This
 * gate is STRUCTURAL — it never inspects the reply text — so it still fires on
 * narration phrasings we've never seen.
 */
export function needsLlmCleanup(reply: Reply, planController: PlanController): boolean {
  return planController.isActive() || reply.receipt.toolsInvoked.length > 0;
}

/**
 * Body for the non-streamed paths: span-removal cleanup on multi-step turns,
 * the raw draft otherwise. `cleanupReply` fails open to the draft, so this
 * never loses the answer.
 */
export async function finalReplyBody(
  reply: Reply,
  planController: PlanController,
  deps: HandleTurnDeps,
): Promise<string> {
  if (needsLlmCleanup(reply, planController)) {
    return cleanupReply(reply.markdown, { fireworks: deps.fireworks, model: deps.model });
  }
  return reply.markdown;
}

/**
 * The turn's single "hero" render. A turn may collect multiple render intents
 * (e.g. two searches); we surface only the LAST one — one structured surface
 * per message — and log the others as an over-render signal. Returns the blocks
 * to splice beneath the markdown body and a fallback-text suffix carrying the
 * same content for notifications + screen readers.
 */
export function heroRenderParts(reply: Reply): {
  renderBlocks: SlackBlock[];
  fallbackSuffix: string;
} {
  const renders = reply.renders;
  if (renders === undefined || renders.length === 0) {
    return { renderBlocks: [], fallbackSuffix: '' };
  }
  if (renders.length > 1) {
    console.info(
      `${logCtx(reply.turnId)} [render] ${renders.length} intents this turn; using last (over-render signal)`,
    );
  }
  const hero = renders[renders.length - 1]!;
  return {
    renderBlocks: renderIntentToBlocks(hero),
    fallbackSuffix: `\n\n${renderIntentToFallbackText(hero)}`,
  };
}

/**
 * Run the turn through the Pi loop.
 *
 * Single path — no fallback. `onDelta` and `history` are forwarded so the
 * streaming / postMessage pipeline is unchanged.
 *
 * A per-turn deadline is applied via `AbortSignal.timeout` (sourced from
 * `deps.behavior.turnDeadlineMs`; default 60 s). If a caller also supplies a
 * `signal`, the two are combined with `AbortSignal.any` so EITHER the user-cancel
 * OR the deadline can abort the run. A timeout abort flows into Pi's graceful
 * abort path (partial reply), not an unhandled rejection.
 */
export async function runTurnLoop(
  turn: Turn,
  deps: HandleTurnDeps,
  registry: ToolRegistry,
  history: ChatMessage[],
  onDelta?: (delta: string) => void | Promise<void>,
  onStatus?: (status: string) => void | Promise<void>,
  onToolStart?: (toolCallId: string, friendlyLabel: string) => void | Promise<void>,
  onToolEnd?: (toolCallId: string, errored: boolean) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<Reply> {
  const model = buildFireworksModel({
    baseUrl: deps.fireworks.baseUrl,
    modelId: deps.model,
  });
  // Route reasoning effort per-turn from the user message + thread depth. Pure
  // heuristic at ingress; the router never emits `'off'` (gpt-oss-120b on
  // Fireworks rejects it — see loop.ts Agent construction).
  const thinkingLevel = pickThinkingLevel({
    text: turn.text,
    threadDepth: history.length,
  });

  // Build the per-turn deadline signal. A deadline of 0 means "no cap".
  // Combine with any caller-supplied signal so both the user-cancel and the
  // deadline can abort the run — whichever fires first wins.
  const deadlineMs = deps.behavior.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
  const turnSignal =
    deadlineMs > 0
      ? signal !== undefined
        ? AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)])
        : AbortSignal.timeout(deadlineMs)
      : signal;

  return runLoopPi(
    turn,
    { baseUrl: deps.fireworks.baseUrl, apiKey: deps.fireworks.apiKey, model },
    registry,
    {
      history,
      slackClient: deps.slackClient,
      thinkingLevel,
      ...(deps.behavior.cliConfirm === true ? { cliConfirm: true } : {}),
      ...(onDelta !== undefined ? { onDelta } : {}),
      ...(onStatus !== undefined ? { onStatus } : {}),
      ...(onToolStart !== undefined ? { onToolStart } : {}),
      ...(onToolEnd !== undefined ? { onToolEnd } : {}),
      ...(deps.ownerProfile !== undefined ? { ownerProfile: deps.ownerProfile } : {}),
      ...(turnSignal !== undefined ? { signal: turnSignal } : {}),
    },
  );
}

/**
 * Attempt a streamed reply via chat.startStream / appendStream / stopStream.
 * Returns `true` if delivery succeeded, `false` if we should fall back to a
 * normal chat.postMessage (e.g. startStream rejected).
 *
 * The model is run INSIDE this helper — never before — so that on failure we
 * can fall through and let the caller run it on the plain-post path.
 */
export async function streamReply(
  turn: Turn,
  deps: HandleTurnDeps,
  ctx: {
    history: ChatMessage[];
    registry: ToolRegistry;
    /**
     * Plan controller for this turn — bound to the TaskCardManager below so
     * `set_plan` / `update_task` tool calls render into the same card.
     * Always passed when streaming; non-streaming fallback doesn't render
     * plan rows but the tools still mutate the controller harmlessly.
     */
    planController: PlanController;
  },
): Promise<boolean> {
  const lctx = logCtx(turn.id);
  const channel = turn.channelId as SlackChannelId;
  const threadTs = turn.threadTs as SlackThreadTs;
  const isAssistant = turn.entrySurface === 'dm';

  // Track the most recent status so the keepalive interval can re-send it.
  // `phaseUpdated` flips true the first time we see a concrete phase string
  // (tool verb or "writing the reply") — that signal lets the keepalive choose
  // between rotating whimsy ("is wadoodling…") and re-sending the real phase.
  //
  // The opener is rotated per-turn ("is thinking…", "is cooking…", "is mulling
  // it over…", etc.) — deterministic by turn id so log slices reproduce.
  // It's NOT a "real phase" in the keepalive-decision sense; we include it
  // and the shimmer-phrase set in the whimsy-class check below.
  const openerPhrase = pickShimmerPhrase(turn.id);
  const openerStatus = pickShimmerStatus(turn.id);
  let lastStatus = openerStatus;
  let phaseUpdated = false;
  // Recognise opener + whimsy phrases so they don't trip the "real phase fired" flag.
  const whimsyPhrases = new Set([...WHIMSY_WORDS.map((w) => `is ${w}…`), `is ${openerPhrase}…`]);
  // Rotation set for the open/whimsy phase — Slack animates through these
  // client-side so the opener feels alive between the 90s keepalive re-sends,
  // instead of sitting on one static phrase. Capped at 10 (Slack's limit).
  const openerLoadingMessages = [openerStatus, ...WHIMSY_WORDS.slice(0, 9).map((w) => `is ${w}…`)];
  const sendStatus = async (status: string, loadingMessages?: string[]): Promise<void> => {
    lastStatus = status;
    if (status !== '' && !whimsyPhrases.has(status)) {
      phaseUpdated = true;
    }
    try {
      await deps.slackClient.assistantThreadsSetStatus({
        channelId: channel,
        threadTs,
        status,
        ...(loadingMessages !== undefined ? { loadingMessages } : {}),
      });
    } catch (err) {
      console.warn(`${lctx} [agent] setStatus failed (continuing):`, err);
    }
  };

  // Live status — now safe for channel @-mentions too (per Slack's 2026-03-05
  // changelog, setStatus works in channel threads with chat:write scope).
  // Uses the rotated opener phrase so consecutive turns don't all say the
  // same thing — feels more alive, same deterministic-by-turn-id guarantee.
  await sendStatus(openerStatus, openerLoadingMessages);

  // Keepalive — Slack auto-clears the shimmer after 2 min, so re-send the latest
  // status every 90s. If no real phase has fired yet, rotate through whimsical
  // "still thinking" words so the shimmer feels alive on long turns. If a phase
  // has fired ("is reading the thread…"), re-send it verbatim — don't override
  // real phase info with whimsy.
  let whimsyTick = 0;
  // Set in `finally` before the shimmer is cleared; guards the keepalive so a
  // tick that fires during teardown can't re-issue a non-empty status AFTER the
  // clear and leave the shimmer stuck until Slack's 2-min timeout (audit #12).
  let turnEnded = false;
  const keepaliveTimer = setInterval(() => {
    if (turnEnded) return;
    if (phaseUpdated) {
      void sendStatus(lastStatus);
    } else {
      // Still in the open phase — keep Slack's native rotation primed.
      void sendStatus(nextWhimsicalStatus(++whimsyTick), openerLoadingMessages);
    }
  }, STATUS_KEEPALIVE_MS);

  try {
    // Lazy stream open — Slack's chat.startStream creates an empty message that
    // shows its own "Thinking..." placeholder until first append. That competes
    // with our setStatus shimmer. Defer startStream until we have real reply
    // tokens; until then, only the shimmer is visible.
    const startParams: StartStreamParams = {
      channel,
      threadTs,
      // Task-card layout: ALWAYS `plan` — every task row (tool-derived shimmer
      // rows AND model-authored set_plan items) renders grouped inside ONE
      // collapsible block, never as separate per-tool cards. Consistent UX every
      // turn, whether or not the model called set_plan.
      taskDisplayMode: 'plan',
      ...(isAssistant
        ? {}
        : { recipientUserId: turn.requester, recipientTeamId: deps.slackTeamId }),
    };
    let streamTs: SlackThreadTs | undefined;
    let streamOpenFailed = false;
    let buffer = '';
    // Stream-vs-buffer decision (see below). The model only narrates its steps
    // when it's USING TOOLS, so we align display with that:
    //  - NO tools → stream the answer live (typing UX; nothing to narrate).
    //  - tools fire → the task card is the live feedback; we BUFFER the body
    //    and deliver it once, cleaned, at the end. The raw narration is never
    //    shown, so there's no flash and no fragile chat.update settle.
    // `bufferMode` latches the moment a tool starts BEFORE any body text has
    // been flushed live (the common case — gpt-oss tools first). If body text
    // already streamed when a tool fires (rare: text-then-tool), we stay live
    // and fall back to the cleanup-then-chat.update settle.
    let bufferMode = false;
    let liveBodyFlushed = false;

    const ensureStreamOpen = async (): Promise<boolean> => {
      if (streamTs !== undefined) return true;
      if (streamOpenFailed) return false;
      // taskDisplayMode is fixed at `plan` (set above) so the layout is the same
      // grouped block on every turn — no open-time resolution from plan state.
      try {
        const handle = await deps.slackClient.chatStartStream(startParams);
        streamTs = handle.ts;
        return true;
      } catch (err) {
        console.warn(`${lctx} [agent] startStream failed; will fall back to postMessage:`, err);
        streamOpenFailed = true;
        return false;
      }
    };

    // Task card — slash commands always show from tool #1; other surfaces use
    // the configured threshold. Threshold of 0 disables the card entirely.
    // sendTaskChunks opens the stream lazily (tools can fire before the first
    // delta arrives) and pushes task_update chunks into the stream message.
    const cardThreshold =
      turn.entrySurface === 'slash_command' ? 1 : deps.behavior.taskCardThreshold;
    const sendTaskChunks = async (chunks: TaskUpdateChunk[]): Promise<void> => {
      if (!(await ensureStreamOpen())) return;
      await deps.slackClient.chatAppendStream({ channel, ts: streamTs!, chunks });
    };
    const taskCard = cardThreshold > 0 ? new TaskCardManager(sendTaskChunks, cardThreshold) : null;
    // Wire model-authored plan rows into the same card. When no card exists
    // (threshold disabled), the plan controller still mutates harmlessly; no
    // listener fires.
    taskCard?.bindPlan(ctx.planController);

    // No prelude task row. Slack's default "Thinking..." placeholder in the
    // streamed message body briefly shows for empty streams, but we can't
    // customize that text (chat.startStream doesn't expose it); a
    // prelude row in the card was confusing rather than helpful per
    // 2026-05-29 feedback. The shimmer status fired above ('is thinking…')
    // is where the agentic indicator lives now.

    const flushBuffer = async (): Promise<void> => {
      if (buffer.length === 0 || streamTs === undefined) return;
      const chunk = buffer;
      buffer = '';
      const appendParams: AppendStreamParams = { channel, ts: streamTs, markdownText: chunk };
      try {
        await deps.slackClient.chatAppendStream(appendParams);
        liveBodyFlushed = true;
      } catch (err) {
        console.warn(`${lctx} [agent] appendStream failed (continuing):`, err);
      }
    };

    const onDelta = async (delta: string): Promise<void> => {
      if (delta.length === 0) return;
      // In buffer mode the body is held and delivered clean at the end (the
      // task card is the live feedback). The full text is in reply.markdown.
      if (bufferMode) return;
      // Live path: open the stream on the first real delta, then batch by FLUSH_CHARS.
      if (!(await ensureStreamOpen())) return;
      buffer += delta;
      if (buffer.length < FLUSH_CHARS) return;
      await flushBuffer();
    };

    const onToolStart = async (toolCallId: string, friendlyLabel: string): Promise<void> => {
      // A tool is starting. If we haven't streamed any answer text live yet,
      // switch to buffer mode: the task card carries progress and the body is
      // delivered cleaned at the end (no narration flash). If body text already
      // streamed, stay live — the cleanup backstop settles it afterwards.
      if (!liveBodyFlushed) bufferMode = true;
      await taskCard?.onToolStart(toolCallId, friendlyLabel);
    };

    const onToolEnd = async (toolCallId: string, errored: boolean): Promise<void> => {
      await taskCard?.onToolEnd(toolCallId, errored);
    };

    const reply = await runTurnLoop(
      turn,
      deps,
      ctx.registry,
      ctx.history,
      onDelta,
      sendStatus,
      onToolStart,
      onToolEnd,
    );

    // Settle the task card before or alongside reply delivery.
    await taskCard?.finish();

    const { renderBlocks, fallbackSuffix } = heroRenderParts(reply);
    const receipt = receiptToContextBlock(reply.receipt);

    // --- Delivery helpers (shared by the three delivery cases below) ---------
    // Post the final reply as a fresh message — the universal fallback that
    // guarantees the answer lands even when the stream is unusable.
    const postFinal = async (body: string): Promise<void> => {
      await deps.slackClient.chatPostMessage({
        channel,
        text: clipNotif(body + fallbackSuffix),
        blocks: [...markdownBlocks(body), ...renderBlocks, receipt],
        thread_ts: threadTs,
      });
    };
    // Close the open stream (render + receipt at the bottom). Returns false if
    // the stream had already expired/closed.
    const closeStream = async (ts: SlackThreadTs): Promise<boolean> => {
      try {
        await deps.slackClient.chatStopStream({ channel, ts, blocks: [...renderBlocks, receipt] });
        return true;
      } catch (err) {
        console.warn(`${lctx} [agent] stopStream failed:`, err);
        return false;
      }
    };
    const cleanBody = (): Promise<string> =>
      cleanupReply(reply.markdown, { fireworks: deps.fireworks, model: deps.model });

    // CASE 1 — BUFFER MODE: a tool fired before any body text was shown, so the
    // body was never streamed. Clean it once and deliver: append into the open
    // stream then close (append/close settled separately — once appended the
    // body is visible, so a later close failure must NOT re-post). If the
    // append fails (or no stream), postFinal so the answer still lands.
    if (bufferMode) {
      const body = await cleanBody();
      if (streamTs !== undefined) {
        let appended = false;
        try {
          if (body.length > 0) {
            await deps.slackClient.chatAppendStream({ channel, ts: streamTs, markdownText: body });
          }
          appended = true;
        } catch (err) {
          console.warn(
            `${lctx} [agent] appendStream (buffered body) failed; will post normally:`,
            err,
          );
        }
        if (appended) {
          await closeStream(streamTs);
          return true;
        }
      }
      await postFinal(body);
      return true;
    }

    // CASE 2 — LIVE, no stream ever opened (empty / tool-only with no text):
    // post the final reply directly.
    if (streamTs === undefined) {
      await postFinal(await finalReplyBody(reply, ctx.planController, deps));
      return true;
    }

    // CASE 3 — LIVE with an open stream (text streamed as it arrived). Flush the
    // tail and close. If the stream had died and nothing actually landed, post
    // the reply so it isn't lost. Otherwise, on the rare text-then-tool turn,
    // settle the finalized message to a narration-free version (only while the
    // stream is alive — a dead stream can't be updated).
    await flushBuffer();
    const streamClosed = await closeStream(streamTs);
    if (!streamClosed && !liveBodyFlushed) {
      await postFinal(await finalReplyBody(reply, ctx.planController, deps));
      return true;
    }
    if (streamClosed && needsLlmCleanup(reply, ctx.planController)) {
      const cleaned = await cleanBody();
      if (cleaned.trim().length > 0 && cleaned.trim() !== reply.markdown.trim()) {
        try {
          await deps.slackClient.chatUpdate({
            channel,
            ts: streamTs,
            text: clipNotif(cleaned + fallbackSuffix),
            blocks: [...markdownBlocks(cleaned), ...renderBlocks, receipt],
          });
        } catch (err) {
          console.warn(`${lctx} [agent] cleanup update failed (continuing):`, err);
        }
      }
    }
    return true;
  } finally {
    turnEnded = true; // stop any keepalive tick from re-issuing status after the clear
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
      console.warn(`${lctx} [agent] setStatus clear failed:`, err);
    }
  }
}
