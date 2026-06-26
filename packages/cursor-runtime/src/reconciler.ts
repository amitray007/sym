/**
 * `CloudRunReconciler` — the poll loop that drives tracked runs to terminal AND
 * delivered. Each tick walks `store.listActive()` and, per run:
 *
 *   - `dispatching` past the grace window → mark `error` (dispatch never
 *     confirmed) and deliver. Otherwise wait (no runId to poll yet).
 *   - `running` → `client.getRun`. A non-retryable poll error marks the run
 *     `error`; a retryable one is logged and retried next tick. A `finished`
 *     run whose PR URL hasn't appeared yet keeps polling, bounded by a grace
 *     window, then delivers summary-only.
 *   - terminal-but-undelivered (incl. a delivery that failed last tick) →
 *     deliver, marking delivered ONLY on a successful `onTransition` so a post
 *     failure or crash retries rather than dropping the notification.
 *
 * Timers and the clock are injected so tests drive ticks deterministically.
 * Per-run failures are isolated — one bad run never stops the loop. Logging is
 * `console.info/warn/error` only (I-7).
 */

import { CursorClientError } from './client.js';
import { isTerminalStatus, type CloudRunStore } from './store.js';

import type { CloudRunRecord, CloudRunView } from './types.js';

/** The slice of `CursorCloudClient` the reconciler needs. */
export interface CloudRunPoller {
  getRun(agentId: string, runId: string): Promise<CloudRunView>;
}

export interface CloudRunReconcilerOptions {
  client: CloudRunPoller;
  store: CloudRunStore;
  /** Deliver a terminal run's result to Slack. Throwing leaves the run undelivered (retried). */
  onTransition: (record: CloudRunRecord) => Promise<void> | void;
  /** Poll interval (ms). Default 10s. */
  intervalMs?: number;
  /** Max age of a `dispatching` intent row before it's failed (ms). Default 60s. */
  graceMs?: number;
  /** Max wait for a finished run's PR URL before delivering summary-only (ms). Default 60s. */
  prGraceMs?: number;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function shortStatusText(view: CloudRunView): string {
  switch (view.status) {
    case 'finished':
      return view.prUrl !== undefined ? 'opened PR' : 'finished (no PR)';
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return view.status;
  }
}

export class CloudRunReconciler {
  readonly #client: CloudRunPoller;
  readonly #store: CloudRunStore;
  readonly #onTransition: (record: CloudRunRecord) => Promise<void> | void;
  readonly #intervalMs: number;
  readonly #graceMs: number;
  readonly #prGraceMs: number;
  readonly #now: () => number;
  readonly #setInterval: (fn: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  #timer: unknown;

  constructor(options: CloudRunReconcilerOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#onTransition = options.onTransition;
    this.#intervalMs = options.intervalMs ?? 10_000;
    this.#graceMs = options.graceMs ?? 60_000;
    this.#prGraceMs = options.prGraceMs ?? 60_000;
    this.#now = options.now ?? (() => Date.now());
    this.#setInterval = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearInterval =
      options.clearIntervalFn ??
      ((handle) => {
        clearInterval(handle as Parameters<typeof clearInterval>[0]);
      });
  }

  /** Begin polling. Existing active rows are picked up immediately on the first tick (R7). */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) {
      this.#clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** One reconciliation pass. Public so tests can drive ticks without timers. */
  async tick(): Promise<void> {
    let rows: CloudRunRecord[];
    try {
      rows = this.#store.listActive();
    } catch (err) {
      console.error(`[cursor] reconciler listActive failed: ${errMsg(err)}`);
      return;
    }
    for (const row of rows) {
      try {
        await this.#reconcileOne(row);
      } catch (err) {
        console.warn(`[cursor] reconcile failed for ${row.dispatchId}: ${errMsg(err)}`);
      }
    }
  }

  async #reconcileOne(row: CloudRunRecord): Promise<void> {
    // Terminal but not yet delivered (e.g. last tick's delivery threw) → retry delivery.
    if (isTerminalStatus(row.status)) {
      await this.#deliver(row.dispatchId);
      return;
    }

    if (row.status === 'dispatching') {
      if (this.#now() - row.createdAt > this.#graceMs) {
        this.#store.markStatus(row.dispatchId, 'error', { statusText: 'dispatch never confirmed' });
        await this.#deliver(row.dispatchId);
      }
      return;
    }

    // status === 'running'
    if (row.runId === undefined || row.agentId === undefined) return;

    let view: CloudRunView;
    try {
      view = await this.#client.getRun(row.agentId, row.runId);
    } catch (err) {
      if (err instanceof CursorClientError && !err.retryable) {
        this.#store.markStatus(row.dispatchId, 'error', { statusText: `failed (${err.code})` });
        await this.#deliver(row.dispatchId);
      } else {
        console.warn(`[cursor] poll failed for run ${row.runId}: ${errMsg(err)}`);
      }
      return;
    }

    if (view.status === 'running') return;

    if (view.status === 'finished' && view.pendingPr) {
      // Finished, but the PR URL hasn't surfaced. Wait, bounded by prGraceMs.
      if (this.#now() - row.updatedAt > this.#prGraceMs) {
        this.#store.markStatus(row.dispatchId, 'finished', { statusText: 'finished (no PR)' });
        await this.#deliver(row.dispatchId);
      }
      return;
    }

    this.#store.markStatus(row.dispatchId, view.status, {
      statusText: shortStatusText(view),
      ...(view.prUrl !== undefined ? { prUrl: view.prUrl } : {}),
    });
    await this.#deliver(row.dispatchId);
  }

  /** Deliver a terminal run once. `markDelivered` runs only after `onTransition` resolves. */
  async #deliver(dispatchId: string): Promise<void> {
    const record = this.#store.get(dispatchId);
    if (record === undefined || record.deliveredAt !== undefined) return;
    if (!isTerminalStatus(record.status)) return;
    await this.#onTransition(record);
    this.#store.markDelivered(dispatchId);
  }
}
