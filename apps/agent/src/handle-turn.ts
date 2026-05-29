import {
  markdownBlock,
  receiptToContextBlock,
  renderIntentToBlocks,
  renderIntentToFallbackText,
  threadToHistory,
} from '@sym/adapter-slack';
import { ToolRegistry } from '@sym/kernel';

import { createBuiltinDispatcher } from './builtin-tools.js';
import { NameResolver } from './name-resolver.js';
import { runLoopPi, nextWhimsicalStatus, WHIMSY_WORDS } from './pi/loop.js';
import { buildFireworksModel } from './pi/model.js';
import { pickThinkingLevel } from './pi/think-router.js';
import { PlanController } from './plan-controller.js';
import { cleanupReply } from './reply-cleanup.js';
import { pickShimmerPhrase, pickShimmerStatus } from './thinking-copy.js';

import type { BehaviorConfig } from './config.js';
import type {
  AppendStreamParams,
  SlackBlock,
  SlackClient,
  StartStreamParams,
  TaskUpdateChunk,
} from '@sym/adapter-slack';
import type {
  ChatMessage,
  Reply,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  Turn,
} from '@sym/contracts';
import type { OwnerIdentity } from '@sym/kernel';

/** Injected dependencies for processing a turn (the testable seam). */
export interface HandleTurnDeps {
  /** Raw Fireworks credentials — required by the Pi loop. */
  fireworks: { baseUrl: string; apiKey: string };
  model: string;
  /** Bot-token client — Sym's identity (replies, streaming, status). */
  slackClient: SlackClient;
  /**
   * Owner user-token client — present when SLACK_OWNER_USER_TOKEN is set.
   * Tools declared `actor: 'user'` use this for broader visibility and act-
   * as-owner writes (Phase B).
   */
  userSlackClient?: SlackClient;
  /** Sym's own bot user id — lets thread history mark its posts as assistant. */
  botUserId: SlackUserId;
  /** Slack team id — required as `recipientTeamId` when streaming into channels. */
  slackTeamId: string;
  /** The channel the user is currently viewing in Slack's assistant panel, if known. */
  viewedChannelId?: string;
  /** Runtime behavior knobs. */
  behavior: BehaviorConfig;
  /**
   * Resolved owner identity (name, tz, title) — embedded in the per-turn
   * metadata so the model can address the owner naturally. Undefined when
   * boot-time resolution hasn't completed or failed.
   */
  ownerProfile?: OwnerIdentity;
  /**
   * Workspace-scoped name resolver — passed into the builtin dispatcher
   * so tool returns surface `@DisplayName` / `#channel-name` instead of
   * raw `<@U…>` / `<#C…>` markup.
   */
  nameResolver: NameResolver;
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

type SendChunks = (chunks: TaskUpdateChunk[]) => Promise<void>;

/** A tracked task — same record, status mutates as start → end fires. */
interface TrackedTask {
  id: string;
  title: string;
  status: 'in_progress' | 'complete' | 'error';
}

/**
 * Manages live task-progress cards embedded in the streaming reply via Slack's
 * native `task_update` chunks (chat.appendStream).
 *
 * **Two modes — one card.**
 *  - **tool-mode** (default): every Pi `tool_execution_start` becomes a card
 *    row. Mirrors the agent's mechanics. Threshold-buffered (`toolCount >=
 *    threshold` flushes all known tasks).
 *  - **plan-mode**: latched on first `set_plan` event from a bound
 *    `PlanController`. The card reflects model-authored intent (the owner's
 *    asks, not the tool names). Tool-derived rows are SUPPRESSED for the
 *    rest of the turn — the per-tool shimmer (`onStatus`) still fires so
 *    the owner can tell *something* is happening; that's the right
 *    granularity. One-way latch: no reverting to tool-mode mid-turn.
 *
 * **Why we key by Pi's `toolCallId`:** gpt-oss-120b commonly emits multiple
 * tool calls in a single round, and Pi runs them in parallel. The events
 * arrive interleaved as `start_A, start_B, start_C, end_B, end_A, end_C`.
 * A single `currentTask` slot would get overwritten on every new start before
 * the matching end could settle it — losing tasks and leaving the card empty.
 * Keying by `toolCallId` lets each task settle independently regardless of
 * arrival order, which also gives the correct UX: all three cards render in
 * parallel as `in_progress`, then transition to `complete` one by one.
 *
 * **Threshold buffering** (tool-mode only): tools that fire before the
 * threshold is crossed are tracked in memory; when threshold crosses, all
 * known tasks flush at their current status. Tasks that already ended in the
 * buffer window (sequential execution) flush as `complete`/`error`; tasks
 * still running (parallel execution) flush as `in_progress` and update later
 * on their end.
 *
 * All chunk sends are best-effort: errors are logged and swallowed so a card
 * failure never blocks reply delivery.
 */
class TaskCardManager {
  private taskCounter = 0;
  /** All known tasks, keyed by Pi's toolCallId. */
  private readonly tasks = new Map<string, TrackedTask>();
  /** Insertion order so chunks flush in tool-start order, not Map-iteration order. */
  private readonly taskOrder: string[] = [];
  private toolCount = 0;
  private active = false;
  /** Set on first `set_plan` event; latches for the rest of the turn. */
  private planMode = false;
  /**
   * Reference to the bound plan controller, kept around so `finish()` can
   * inspect terminal plan-item states and auto-settle anything the model
   * left hanging. Null until `bindPlan` is called.
   */
  private boundPlan: PlanController | null = null;

  constructor(
    /** Callback that pushes task_update chunks into the open stream. */
    private readonly sendChunks: SendChunks,
    /** Tool calls before the card appears (1 = always show from first tool). */
    private readonly threshold: number,
  ) {}

  /**
   * Subscribe to a `PlanController` for model-authored plan rows. Call once
   * during stream setup. The first `set_plan` event flips the card into
   * plan-mode and suppresses subsequent tool-derived rows.
   */
  bindPlan(controller: PlanController): void {
    this.boundPlan = controller;
    controller.subscribe(async (event) => {
      if (event.type === 'set_plan') {
        // Latch into plan-mode and render every item at `pending`. This is
        // the activation moment for the card — even if tool calls already
        // fired, their rows are discarded and replaced by the plan view.
        this.planMode = true;
        this.active = true;
        const chunks: TaskUpdateChunk[] = event.items.map((item) => ({
          type: 'task_update',
          id: item.id,
          title: item.title,
          status: 'pending',
        }));
        await this.sendChunks(chunks).catch((err) =>
          console.warn('[agent] plan set_plan flush failed (continuing):', err),
        );
        return;
      }
      // update_task — single row update. `blocked` maps to Slack's native
      // `error` status plus the reason in `details`, since TaskUpdateChunk
      // doesn't carry a dedicated blocked state today.
      const item = event.item;
      const chunk: TaskUpdateChunk = {
        type: 'task_update',
        id: item.id,
        title: item.title,
        status: item.status === 'blocked' ? 'error' : item.status,
        ...(item.note !== undefined ? { details: item.note } : {}),
      };
      await this.sendChunks([chunk]).catch((err) =>
        console.warn('[agent] plan update_task flush failed (continuing):', err),
      );
    });
  }

  async onToolStart(toolCallId: string, friendlyLabel: string): Promise<void> {
    // Plan-mode suppresses tool-derived rows entirely — the model's plan IS
    // the card; the per-tool shimmer is the right granularity for "what's
    // happening right now."
    if (this.planMode) return;

    this.toolCount++;
    const id = `task-${++this.taskCounter}`;
    const title = capitalize(friendlyLabel);
    const task: TrackedTask = { id, title, status: 'in_progress' };
    this.tasks.set(toolCallId, task);
    this.taskOrder.push(toolCallId);

    if (!this.active && this.toolCount >= this.threshold) {
      // Threshold crossed — flush ALL known tasks at their current status. Any
      // task that already ended (sequential mode) is complete/error; any still
      // running (parallel mode) is in_progress and will update on its onToolEnd.
      this.active = true;
      const chunks: TaskUpdateChunk[] = this.taskOrder
        .map((tid) => this.tasks.get(tid))
        .filter((t): t is TrackedTask => t !== undefined)
        .map(
          (t): TaskUpdateChunk => ({
            type: 'task_update',
            id: t.id,
            title: t.title,
            status: t.status,
          }),
        );
      await this.sendChunks(chunks).catch((err) =>
        console.warn('[agent] task card start failed (continuing):', err),
      );
    } else if (this.active) {
      await this.sendChunks([{ type: 'task_update', id, title, status: 'in_progress' }]).catch(
        (err) => console.warn('[agent] task card update failed (continuing):', err),
      );
    }
  }

  async onToolEnd(toolCallId: string, errored: boolean): Promise<void> {
    if (this.planMode) return;
    const task = this.tasks.get(toolCallId);
    if (task === undefined) return;
    task.status = errored ? 'error' : 'complete';
    // Only push an update chunk if the card is already visible. While
    // buffered, the new status will flow out as part of the threshold-flush.
    if (this.active) {
      await this.sendChunks([
        { type: 'task_update', id: task.id, title: task.title, status: task.status },
      ]).catch((err) => console.warn('[agent] task card settle failed (continuing):', err));
    }
  }

  async finish(): Promise<void> {
    // **Plan-mode auto-complete.** When the turn ends and the model produced
    // a reply, any plan items left in `pending` / `in_progress` should
    // visually close as complete — leaving them unsettled punishes the
    // owner for the model's silence about calling `update_task`. We
    // explicitly DO NOT touch items the model marked `blocked` (mapped to
    // error in the chunk shape): the model affirmatively raised those, the
    // owner needs to see them, the reply text typically explains them.
    //
    // Reversal of the earlier "honest" design — see the 2026-05-29 dogfood
    // screenshot where unsettled rows displayed as ⚠️ and made a successful
    // turn look like a failure. Honesty about un-touched items isn't worth
    // implying failure on a turn that actually delivered.
    if (this.planMode && this.boundPlan !== null) {
      const stuck = this.boundPlan
        .snapshot()
        .filter((item) => item.status === 'pending' || item.status === 'in_progress')
        .map(
          (item): TaskUpdateChunk => ({
            type: 'task_update',
            id: item.id,
            title: item.title,
            status: 'complete',
          }),
        );
      if (stuck.length > 0) {
        await this.sendChunks(stuck).catch((err) =>
          console.warn('[agent] plan auto-complete on finish failed (continuing):', err),
        );
      }
      return;
    }
    if (this.planMode) return;

    // Defensive: if the loop terminated mid-flight (no tool_execution_end for
    // some task), mark anything still in_progress as complete so cards don't
    // get stuck mid-air. Only runs when the card was ever shown.
    if (!this.active) return;
    const stuck: TaskUpdateChunk[] = this.taskOrder
      .map((tid) => this.tasks.get(tid))
      .filter((t): t is TrackedTask => t !== undefined && t.status === 'in_progress')
      .map((t) => ({ type: 'task_update', id: t.id, title: t.title, status: 'complete' }));
    if (stuck.length === 0) return;
    try {
      await this.sendChunks(stuck);
    } catch (err) {
      console.warn('[agent] task card finish failed (continuing):', err);
    }
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * The turn's single "hero" render. A turn may collect multiple render intents
 * (e.g. two searches); we surface only the LAST one — one structured surface
 * per message — and log the others as an over-render signal. Returns the blocks
 * to splice beneath the markdown body and a fallback-text suffix carrying the
 * same content for notifications + screen readers.
 */
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
function needsLlmCleanup(reply: Reply, planController: PlanController): boolean {
  return planController.isActive() || reply.receipt.toolsInvoked.length > 0;
}

/**
 * Body for the non-streamed paths: span-removal cleanup on multi-step turns,
 * the raw draft otherwise. `cleanupReply` fails open to the draft, so this
 * never loses the answer.
 */
async function finalReplyBody(
  reply: Reply,
  planController: PlanController,
  deps: HandleTurnDeps,
): Promise<string> {
  if (needsLlmCleanup(reply, planController)) {
    return cleanupReply(reply.markdown, { fireworks: deps.fireworks, model: deps.model });
  }
  return reply.markdown;
}

function heroRenderParts(reply: Reply): { renderBlocks: SlackBlock[]; fallbackSuffix: string } {
  const renders = reply.renders;
  if (renders === undefined || renders.length === 0) {
    return { renderBlocks: [], fallbackSuffix: '' };
  }
  if (renders.length > 1) {
    console.info(`[render] ${renders.length} intents this turn; using last (over-render signal)`);
  }
  const hero = renders[renders.length - 1]!;
  return {
    renderBlocks: renderIntentToBlocks(hero),
    fallbackSuffix: `\n\n${renderIntentToFallbackText(hero)}`,
  };
}

/** Max characters in a derived assistant-thread title (Slack truncates long ones). */
const TITLE_MAX_CHARS = 60;
/** Words pulled from the user's text when deriving a title. */
const TITLE_MAX_WORDS = 8;

/**
 * Heuristic title from a user message — strips bot mentions / links, takes the
 * first few words, truncates. Used for `assistant.threads.setTitle` on the
 * first user turn in an assistant-panel thread so Slack's left-rail History
 * shows something readable instead of the raw question.
 */
function deriveTitle(userText: string): string {
  const cleaned = userText
    // Drop bot mentions like <@U123ABC> and channel/user link syntax.
    .replace(/<[@#!][^>]+>/g, '')
    // Collapse URLs to their host.
    .replace(/https?:\/\/(\S+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return 'New chat with Sym';
  const words = cleaned.split(' ').slice(0, TITLE_MAX_WORDS).join(' ');
  const truncated =
    words.length > TITLE_MAX_CHARS ? `${words.slice(0, TITLE_MAX_CHARS - 1)}…` : words;
  return capitalize(truncated);
}

/**
 * Set the assistant-panel thread title from the user's first message — only
 * for DM/assistant-panel turns AND only when the thread has no prior user
 * messages (the welcome post from `handleAssistantThreadStarted` is an
 * assistant message and doesn't count). Best-effort: failures are logged.
 */
async function maybeSetThreadTitleFromTurn(
  turn: Turn,
  deps: HandleTurnDeps,
  history: ChatMessage[],
): Promise<void> {
  if (turn.entrySurface !== 'dm') return;
  if (turn.channelId === undefined || turn.threadTs === undefined) return;
  const hasPriorUserTurn = history.some((m) => m.role === 'user');
  if (hasPriorUserTurn) return;
  const title = deriveTitle(turn.text ?? '');
  try {
    await deps.slackClient.assistantThreadsSetTitle({
      channelId: turn.channelId as SlackChannelId,
      threadTs: turn.threadTs as SlackThreadTs,
      title,
    });
  } catch (err) {
    console.warn('[agent] setTitle from first user turn failed (continuing):', err);
  }
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
  onToolStart?: (toolCallId: string, friendlyLabel: string) => void | Promise<void>,
  onToolEnd?: (toolCallId: string, errored: boolean) => void | Promise<void>,
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
  return runLoopPi(
    turn,
    { baseUrl: deps.fireworks.baseUrl, apiKey: deps.fireworks.apiKey, model },
    registry,
    {
      history,
      slackClient: deps.slackClient,
      thinkingLevel,
      ...(onDelta !== undefined ? { onDelta } : {}),
      ...(onStatus !== undefined ? { onStatus } : {}),
      ...(onToolStart !== undefined ? { onToolStart } : {}),
      ...(onToolEnd !== undefined ? { onToolEnd } : {}),
      ...(deps.ownerProfile !== undefined ? { ownerProfile: deps.ownerProfile } : {}),
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
    let messages;
    if (turn.threadTs !== undefined) {
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
    const history = threadToHistory(messages, {
      botUserId: deps.botUserId,
      ...(turn.ts !== undefined ? { excludeTs: turn.ts } : {}),
    });
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
    /**
     * Plan controller for this turn — bound to the TaskCardManager below so
     * `set_plan` / `update_task` tool calls render into the same card.
     * Always passed when streaming; non-streaming fallback doesn't render
     * plan rows but the tools still mutate the controller harmlessly.
     */
    planController: PlanController;
  },
): Promise<boolean> {
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
      console.warn('[agent] setStatus failed (continuing):', err);
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
      // Task-card layout, resolved at open time (see ensureStreamOpen):
      //  - `plan`     when the model has latched a plan — model-authored intent
      //               renders as ONE grouped plan block.
      //  - `timeline` otherwise — tool-call rows as individual cards in arrival
      //               order (also Slack's default; set explicitly for stability).
      taskDisplayMode: 'timeline',
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
      // Resolve task-card layout from plan state AT OPEN TIME. `setPlan` flips
      // the controller active synchronously, before its flush opens the stream
      // (PlanController.setPlan sets active=true, then emits → the card's
      // set_plan handler calls sendChunks → here). So a plan-mode turn opens as
      // a grouped `plan` block; tool-only turns stay `timeline`. If a text delta
      // opened the stream before any set_plan, it stays `timeline` — graceful.
      startParams.taskDisplayMode = ctx.planController.isActive() ? 'plan' : 'timeline';
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
        console.warn('[agent] appendStream failed (continuing):', err);
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

    // BUFFER MODE — a tool fired before any body text was shown. The body was
    // never streamed live, so clean it once and deliver it (no flash, no
    // chat.update settle). The task card already showed progress above.
    if (bufferMode) {
      const body = await cleanupReply(reply.markdown, {
        fireworks: deps.fireworks,
        model: deps.model,
      });
      const blocks = [markdownBlock(body), ...renderBlocks, receipt];

      // Try to finish the open stream. On a LONG turn (e.g. the model timed out
      // after several tool calls) the Slack streaming session expires and
      // appendStream throws `message_not_found`. Append and stop are settled
      // SEPARATELY: once the body has been appended it is already visible, so a
      // later stopStream failure must NOT trigger a re-post (that double-posts
      // the answer). Only fall back to a fresh postMessage when the body was
      // never delivered into the stream.
      if (streamTs !== undefined) {
        let appended = false;
        try {
          if (body.length > 0) {
            await deps.slackClient.chatAppendStream({ channel, ts: streamTs, markdownText: body });
          }
          appended = true;
        } catch (err) {
          console.warn('[agent] appendStream (buffered body) failed; will post normally:', err);
        }
        if (appended) {
          // Body is in the stream — close it best-effort; a stopStream failure
          // here leaves the body visible, so do NOT re-post.
          try {
            await deps.slackClient.chatStopStream({
              channel,
              ts: streamTs,
              blocks: [...renderBlocks, receipt],
            });
          } catch (err) {
            console.warn('[agent] stopStream failed after delivering body (continuing):', err);
          }
          return true;
        }
        // append failed → fall through to postMessage so the answer still lands.
      }
      await deps.slackClient.chatPostMessage({
        channel,
        text: body + fallbackSuffix,
        blocks,
        thread_ts: threadTs,
      });
      return true;
    }

    // LIVE PATH — no-tool turn (streamed as-is), or the rare text-then-tool turn.
    // No body text streamed at all (empty / tool-only with no text) → post final.
    if (streamTs === undefined) {
      const body = await finalReplyBody(reply, ctx.planController, deps);
      const blocks = [markdownBlock(body), ...renderBlocks, receipt];
      await deps.slackClient.chatPostMessage({
        channel,
        text: body + fallbackSuffix,
        blocks,
        thread_ts: threadTs,
      });
      return true;
    }

    await flushBuffer();
    let streamClosed = true;
    try {
      await deps.slackClient.chatStopStream({
        channel,
        ts: streamTs,
        blocks: [...renderBlocks, receipt],
      });
    } catch (err) {
      streamClosed = false;
      console.warn('[agent] stopStream failed:', err);
    }

    // If the stream died and NOTHING was ever delivered live, post the reply so
    // it still lands (same long-turn expiry as the buffer path).
    if (!streamClosed && !liveBodyFlushed) {
      const body = await finalReplyBody(reply, ctx.planController, deps);
      await deps.slackClient.chatPostMessage({
        channel,
        text: body + fallbackSuffix,
        blocks: [markdownBlock(body), ...renderBlocks, receipt],
        thread_ts: threadTs,
      });
      return true;
    }

    // Rare case: answer text streamed live AND a tool fired afterwards. The live
    // text may carry narration the model added later — settle the finalized
    // message to a cleaned version if span-removal changed anything. Only when
    // the stream is still alive (a dead stream can't be updated).
    if (streamClosed && needsLlmCleanup(reply, ctx.planController)) {
      const cleaned = await cleanupReply(reply.markdown, {
        fireworks: deps.fireworks,
        model: deps.model,
      });
      if (cleaned.trim().length > 0 && cleaned.trim() !== reply.markdown.trim()) {
        try {
          await deps.slackClient.chatUpdate({
            channel,
            ts: streamTs,
            text: cleaned + fallbackSuffix,
            blocks: [markdownBlock(cleaned), ...renderBlocks, receipt],
          });
        } catch (err) {
          console.warn('[agent] cleanup update failed (continuing):', err);
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
    // Resolve the transcript mentions AND the viewed-channel label so the model
    // gets `#general` / `a direct message with @Name` — never a raw id. A `U…`
    // viewed id is a DM (the other party's user id); resolve it as a user.
    let rewrittenTranscript = transcript;
    let viewedLabel: string;
    try {
      rewrittenTranscript = await deps.nameResolver.rewriteMentions(transcript, deps.slackClient);
      if (NameResolver.isUserId(viewed)) {
        const name = await deps.nameResolver.resolveUser(viewed, deps.slackClient);
        viewedLabel = name !== viewed ? `a direct message with ${name}` : 'a direct message';
      } else {
        const resolvedName = await deps.nameResolver.resolveChannel(viewed, deps.slackClient);
        viewedLabel = resolvedName !== viewed ? `#${resolvedName}` : 'another channel';
      }
    } catch {
      // Never leak the raw id — fall back to a generic, id-free phrase.
      viewedLabel = NameResolver.isUserId(viewed) ? 'a direct message' : 'another channel';
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

  // Independent reads — run them concurrently to shave a round-trip off every
  // assistant-panel turn (each does its own Slack fetch + name resolution).
  const [baseHistory, viewedContext] = await Promise.all([
    loadTurnHistory(turn, deps),
    loadViewedChannelContext(turn, deps),
  ]);
  const history = viewedContext ? [viewedContext, ...baseHistory] : baseHistory;

  // Rewrite the owner's own message — their text can carry raw `<@U…>` /
  // `<#C…>` markup when Slack converted typed @-mentions on send. Without
  // this pass, the model receives `<@U042>` in the user-turn metadata frame
  // and may parrot it back. Best-effort: a resolver miss falls through to
  // the raw text, identical to the pre-resolver behaviour.
  let rewrittenTurn = turn;
  if (turn.text !== undefined && turn.text.length > 0) {
    try {
      const rewrittenText = await deps.nameResolver.rewriteMentions(turn.text, deps.slackClient);
      if (rewrittenText !== turn.text) {
        rewrittenTurn = { ...turn, text: rewrittenText };
      }
    } catch {
      // fall through with the raw turn
    }
  }

  // First user turn in an assistant-panel thread → derive a real title from
  // their question. Fire-and-forget so it doesn't add latency to the reply.
  // Checks `baseHistory` (raw thread) not `history` (which includes synthetic
  // viewed-channel context as a user role message). Use the resolver-rewritten
  // turn so the title shows display names, not raw `<@U…>` markup.
  void maybeSetThreadTitleFromTurn(rewrittenTurn, deps, baseHistory);

  // Per-turn plan controller — both streaming and post-message paths share
  // this. On the streaming path it drives the TaskCardManager into plan-mode
  // when the model calls `set_plan`; on the post-message path it's a no-op
  // state holder (no card exists) but the tool calls still succeed cleanly.
  const planController = new PlanController();

  const builtin = createBuiltinDispatcher({
    slackClient: deps.slackClient,
    botUserId: deps.botUserId,
    ...(deps.userSlackClient !== undefined ? { userSlackClient: deps.userSlackClient } : {}),
    ownerPostMarker: deps.behavior.ownerPostMarker,
    planController,
    nameResolver: deps.nameResolver,
  });
  const registry = new ToolRegistry(builtin);

  // Threaded turns: try streaming; fall through to postMessage only if it fails.
  if (turn.threadTs !== undefined) {
    const streamed = await streamReply(rewrittenTurn, deps, { history, registry, planController });
    if (streamed) return;
  }

  // Non-threaded or stream fallback: run the loop and post normally.
  const reply = await runTurnLoop(rewrittenTurn, deps, registry, history);

  const { renderBlocks, fallbackSuffix } = heroRenderParts(reply);
  const body = await finalReplyBody(reply, planController, deps);
  const blocks = [markdownBlock(body), ...renderBlocks, receiptToContextBlock(reply.receipt)];
  await deps.slackClient.chatPostMessage({
    channel: turn.channelId,
    text: body + fallbackSuffix,
    blocks,
    // Reply in-thread when the turn is already threaded; top-level otherwise.
    ...(turn.threadTs !== undefined ? { thread_ts: turn.threadTs } : {}),
  });
}
