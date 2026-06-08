/**
 * Task-card manager — maintains the live tool-progress card in a Slack stream.
 *
 * Translates `onToolStart` / `onToolEnd` callbacks from the Pi loop into
 * `task_update` chunks that render inside the stream message's grouped plan
 * block. Also binds the `PlanController` so model-authored `set_plan` /
 * `update_task` rows land in the same card.
 */

import type { PlanController } from './plan-controller.js';
import type { TaskUpdateChunk } from '@sym/adapter-slack';

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
export class TaskCardManager {
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
        // Latch into plan-mode and render every item at `pending`, the
        // activation moment for the card.
        //
        // If tool rows were ALREADY shown (a non-silent tool fired before the
        // model called set_plan), settle them to `complete` first — plan-mode
        // suppresses their onToolEnd, so otherwise they'd sit stuck in_progress
        // above the plan (audit #17). We can't remove rows from a Slack stream,
        // but settling them stops them reading as failed/hung.
        const hadVisibleToolRows = this.active;
        this.planMode = true;
        this.active = true;
        const settle: TaskUpdateChunk[] = hadVisibleToolRows
          ? this.taskOrder
              .map((tid) => this.tasks.get(tid))
              .filter((t): t is TrackedTask => t !== undefined && t.status === 'in_progress')
              .map((t) => ({ type: 'task_update', id: t.id, title: t.title, status: 'complete' }))
          : [];
        const planChunks: TaskUpdateChunk[] = event.items.map((item) => ({
          type: 'task_update',
          id: item.id,
          title: item.title,
          status: 'pending',
        }));
        await this.sendChunks([...settle, ...planChunks]).catch((err) =>
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
      await this.flushAll();
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

  /**
   * Reflect a destructive tool's confirmation gate ON ITS OWN ROW — never as a
   * second "decision" row. Pi emits `tool_execution_start` (→ onToolStart, which
   * creates the row) BEFORE `beforeToolCall`, so the row keyed by this
   * `toolCallId` already exists when the gate fires; we just update it. The
   * interactive prompt itself is a separate, ephemeral Slack message that gets
   * deleted once the owner decides — this row is the durable record.
   *
   *  - `awaiting`  — owner is being asked: "<label> — awaiting approval" (live).
   *                  A gate is always worth showing, so this forces the card
   *                  visible even below the buffering threshold.
   *  - `approved`  — restore the plain running label; the tool then runs and its
   *                  `onToolEnd` settles the SAME row (✓). In plan-mode no
   *                  onToolEnd fires (tool rows are suppressed), so settle here.
   *  - `denied`    — "<label> — denied" (✗). The tool won't run; a later
   *                  blocked `onToolEnd` keeps this title (it never rewrites it).
   *
   * In plan-mode the matching `onToolStart` was suppressed, so the row may not
   * exist yet — we create it, because a confirmation gate is too important to
   * hide even when plain tool rows are.
   */
  async onToolGate(
    toolCallId: string,
    phase: 'awaiting' | 'approved' | 'denied',
    friendlyLabel: string,
  ): Promise<void> {
    const base = capitalize(friendlyLabel);
    let task = this.tasks.get(toolCallId);
    if (task === undefined) {
      task = { id: `task-${++this.taskCounter}`, title: base, status: 'in_progress' };
      this.tasks.set(toolCallId, task);
      this.taskOrder.push(toolCallId);
    }

    if (phase === 'awaiting') {
      task.title = `${base} — awaiting approval`;
      task.status = 'in_progress';
    } else if (phase === 'denied') {
      task.title = `${base} — denied`;
      task.status = 'error';
    } else {
      task.title = base;
      // tool-mode: onToolEnd settles it; plan-mode: it won't fire, so settle now.
      task.status = this.planMode ? 'complete' : 'in_progress';
    }

    // A gate must be visible regardless of the buffering threshold.
    if (!this.active) {
      this.active = true;
      await this.flushAll();
      return;
    }
    await this.sendChunks([
      { type: 'task_update', id: task.id, title: task.title, status: task.status },
    ]).catch((err) => console.warn('[agent] task card gate update failed (continuing):', err));
  }

  /**
   * Re-emit the current card verbatim to keep the Slack stream in its
   * streaming state. Slack auto-finalizes an idle streaming message, so on a
   * long buffer-mode turn (a single long-running tool, or a slow final answer)
   * the stream can expire between tool events and the closing body append then
   * fails with `message_not_in_streaming_state`. A periodic touch from the
   * keepalive timer resets Slack's idle clock. The chunks carry the same ids
   * and statuses, so the re-send is visually idempotent (rows replace in place).
   * No-op until the card is visible — nothing to keep alive before then.
   */
  async touch(): Promise<void> {
    if (!this.active) return;
    // Plan-mode rows live in the bound controller, NOT in `tasks` (which only
    // ever holds tool-keyed rows, all suppressed once plan mode latches). A
    // plain `flushAll` would re-emit nothing on a set_plan-first turn — the
    // common long-turn case — leaving the stream to idle out. Re-emit the plan
    // snapshot instead, mirroring `bindPlan`'s update_task chunk mapping so the
    // re-send is byte-identical (blocked → error, note → details preserved).
    if (this.planMode && this.boundPlan !== null) {
      const chunks: TaskUpdateChunk[] = this.boundPlan.snapshot().map((item) => ({
        type: 'task_update',
        id: item.id,
        title: item.title,
        status: item.status === 'blocked' ? 'error' : item.status,
        ...(item.note !== undefined ? { details: item.note } : {}),
      }));
      if (chunks.length === 0) return;
      await this.sendChunks(chunks).catch((err) =>
        console.warn('[agent] task card touch (plan) failed (continuing):', err),
      );
      return;
    }
    await this.flushAll();
  }

  /** Flush every known task at its current status (threshold-cross + gate-reveal). */
  private async flushAll(): Promise<void> {
    const chunks: TaskUpdateChunk[] = this.taskOrder
      .map((tid) => this.tasks.get(tid))
      .filter((t): t is TrackedTask => t !== undefined)
      .map((t) => ({ type: 'task_update', id: t.id, title: t.title, status: t.status }));
    if (chunks.length === 0) return;
    await this.sendChunks(chunks).catch((err) =>
      console.warn('[agent] task card flush failed (continuing):', err),
    );
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
