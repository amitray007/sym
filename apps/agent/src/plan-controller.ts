/**
 * Per-turn plan controller — the model-authored counterpart to the
 * tool-call-driven task card.
 *
 * Pi's tool-execution events already feed the `TaskCardManager` to render a
 * live card of *what mechanics the agent is using*. That's useful but
 * machine-flavored ("Searching Slack", "Reading the channel"). When the
 * model wants to externalize *intent* ("Find the latest incident",
 * "Summarize what we learned"), it calls the `set_plan` / `update_task`
 * tools — those flow through this controller instead.
 *
 * **One-way mode latch.** First `setPlan()` call activates plan mode for the
 * rest of the turn. After that, the card renders model-authored items and
 * the tool-call-driven rows are suppressed (the per-tool shimmer still
 * fires via `onStatus`; that's the right granularity for the owner). This
 * latch is deliberate — interleaving tool rows with plan items mid-turn
 * would create a card whose meaning shifts under the owner's eye.
 *
 * **Stateless preserved.** This controller lives for the duration of one
 * turn. The plan itself is reified only as the edited Slack message — when
 * the next turn fetches history, only the final assistant reply is
 * persisted; plan rows are not (yet). See the chunk-3 persistence
 * discussion for the path to surviving them.
 */

/** Statuses a plan item can be in. Mirrors Slack's `TaskUpdateChunk.status` plus a `'blocked'` virtual state mapped to `'error'` at render. */
export type PlanItemStatus = 'pending' | 'in_progress' | 'complete' | 'blocked';

/** A single plan item. `id` is assigned on `setPlan`, format `p<n>` (1-indexed). */
export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  /** Free-text note attached on `updateTask` — typically the reason for `blocked`. */
  note?: string;
}

/** Events emitted to subscribers (currently just `TaskCardManager.bindPlan`). */
export type PlanEvent =
  | { type: 'set_plan'; items: PlanItem[] }
  | { type: 'update_task'; item: PlanItem };

type Listener = (event: PlanEvent) => void | Promise<void>;

/**
 * Why a `setPlan` call returned no ids.
 *
 * Today the only reason is `'already_planned'` — the latch fires once per
 * turn, repeat calls are a no-op so the model can't reset its plan mid-flight.
 */
export interface SetPlanResult {
  ok: boolean;
  /** Item ids in insertion order. Empty when `ok=false`. */
  ids: string[];
  /** Failure reason; absent on success. */
  reason?: 'already_planned' | 'empty';
}

export interface UpdateTaskResult {
  ok: boolean;
  /** Failure reason; absent on success. */
  reason?: 'unknown_id' | 'no_plan';
}

export class PlanController {
  private items: PlanItem[] = [];
  private listeners: Listener[] = [];
  private active = false;

  /** Subscribe to plan mutations (set + update). Called by `TaskCardManager.bindPlan`. */
  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  /** Whether plan mode is engaged for this turn. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Snapshot of current items (cloned, safe for callers to mutate). Mainly
   * useful for tests and any final-state inspection.
   */
  snapshot(): PlanItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  /**
   * Set the plan. Idempotent: subsequent calls in the same turn return
   * `already_planned` without mutating state. An empty `items` array is
   * rejected (`empty`) — the model should just answer instead.
   */
  async setPlan(titles: string[]): Promise<SetPlanResult> {
    if (this.active) {
      return { ok: false, ids: [], reason: 'already_planned' };
    }
    const cleaned = titles.map((t) => t.trim()).filter((t) => t.length > 0);
    if (cleaned.length === 0) {
      return { ok: false, ids: [], reason: 'empty' };
    }
    this.active = true;
    this.items = cleaned.map((title, idx) => ({
      id: `p${idx + 1}`,
      title,
      status: 'pending' as const,
    }));
    await this.emit({ type: 'set_plan', items: this.snapshot() });
    return { ok: true, ids: this.items.map((i) => i.id) };
  }

  /**
   * Update a single plan item's status (and optional note). Returns `ok:false`
   * with `unknown_id` if no item matches, or `no_plan` if `setPlan` hasn't
   * been called this turn — both signal model error, not a card failure.
   */
  async updateTask(id: string, status: PlanItemStatus, note?: string): Promise<UpdateTaskResult> {
    if (!this.active) {
      return { ok: false, reason: 'no_plan' };
    }
    const item = this.items.find((i) => i.id === id);
    if (item === undefined) {
      return { ok: false, reason: 'unknown_id' };
    }
    item.status = status;
    if (note !== undefined && note.length > 0) {
      item.note = note;
    }
    await this.emit({ type: 'update_task', item: { ...item } });
    return { ok: true };
  }

  private async emit(event: PlanEvent): Promise<void> {
    for (const fn of this.listeners) {
      // Best-effort: a listener throwing must not break sibling listeners or
      // the tool dispatch path. The TaskCardManager already swallows chunk
      // failures internally; this is belt-and-braces.
      try {
        await fn(event);
      } catch (err) {
        console.warn('[plan] listener threw (continuing):', err);
      }
    }
  }
}
