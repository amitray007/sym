import { describe, expect, it, vi } from 'vitest';

import { PlanController } from '../src/plan-controller.js';
import { TaskCardManager } from '../src/task-card-manager.js';

import type { TaskUpdateChunk } from '@sym/adapter-slack';

/** A sendChunks collector — accumulates every chunk the card emits. */
function collector() {
  const chunks: TaskUpdateChunk[] = [];
  const send = vi.fn(async (cs: TaskUpdateChunk[]) => {
    chunks.push(...cs);
  });
  return { chunks, send };
}

describe('TaskCardManager — plan mode', () => {
  it('renders every plan item as pending on set_plan', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    const plan = new PlanController();
    card.bindPlan(plan);

    await plan.setPlan(['Find the incident', 'Summarize it']);

    expect(chunks).toEqual([
      { type: 'task_update', id: 'p1', title: 'Find the incident', status: 'pending' },
      { type: 'task_update', id: 'p2', title: 'Summarize it', status: 'pending' },
    ]);
  });

  it('maps update_task statuses, with blocked → error + details', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    const plan = new PlanController();
    card.bindPlan(plan);
    await plan.setPlan(['A', 'B']);
    chunks.length = 0;

    await plan.updateTask('p1', 'in_progress');
    await plan.updateTask('p1', 'complete');
    await plan.updateTask('p2', 'blocked', 'need owner input');

    expect(chunks).toEqual([
      { type: 'task_update', id: 'p1', title: 'A', status: 'in_progress' },
      { type: 'task_update', id: 'p1', title: 'A', status: 'complete' },
      { type: 'task_update', id: 'p2', title: 'B', status: 'error', details: 'need owner input' },
    ]);
  });

  it('touch() re-emits the plan snapshot to keep the stream warm (set_plan-first turn)', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    const plan = new PlanController();
    card.bindPlan(plan);
    await plan.setPlan(['Find it', 'Summarize']);
    await plan.updateTask('p1', 'complete');
    await plan.updateTask('p2', 'blocked', 'need owner input');
    chunks.length = 0;

    await card.touch();
    // No pre-plan tool rows exist; the rows live in the controller. touch() must
    // re-emit the plan snapshot at current status (blocked → error + details),
    // not silently send nothing.
    expect(chunks).toEqual([
      { type: 'task_update', id: 'p1', title: 'Find it', status: 'complete' },
      {
        type: 'task_update',
        id: 'p2',
        title: 'Summarize',
        status: 'error',
        details: 'need owner input',
      },
    ]);
  });

  it('suppresses tool-derived rows once plan mode has latched', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    const plan = new PlanController();
    card.bindPlan(plan);
    await plan.setPlan(['A']);
    chunks.length = 0;

    await card.onToolStart('c1', 'searching slack');
    await card.onToolEnd('c1', false);

    expect(chunks).toEqual([]); // the model's plan is the card; tool rows are noise
  });

  it('settles already-shown tool rows when set_plan latches afterwards (audit #17)', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    const plan = new PlanController();
    card.bindPlan(plan);
    await card.onToolStart('c1', 'reading the channel'); // shown, in_progress
    chunks.length = 0;

    await plan.setPlan(['Summarize']);

    expect(chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: 'Reading the channel', status: 'complete' },
      { type: 'task_update', id: 'p1', title: 'Summarize', status: 'pending' },
    ]);
  });

  it('does not emit settle rows for tools that were never shown (below threshold)', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 5); // high threshold → tool stays buffered, unshown
    const plan = new PlanController();
    card.bindPlan(plan);
    await card.onToolStart('c1', 'reading the channel'); // buffered, not on the card
    chunks.length = 0;

    await plan.setPlan(['Summarize']);

    expect(chunks).toEqual([
      { type: 'task_update', id: 'p1', title: 'Summarize', status: 'pending' },
    ]);
  });

  it('finish() auto-completes pending/in_progress plan items but leaves blocked', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    const plan = new PlanController();
    card.bindPlan(plan);
    await plan.setPlan(['A', 'B', 'C']); // p1, p2, p3
    await plan.updateTask('p1', 'in_progress');
    await plan.updateTask('p2', 'blocked', 'reason'); // must NOT be auto-completed
    chunks.length = 0;

    await card.finish();

    expect(chunks).toEqual([
      { type: 'task_update', id: 'p1', title: 'A', status: 'complete' },
      { type: 'task_update', id: 'p3', title: 'C', status: 'complete' },
    ]);
  });
});

describe('TaskCardManager — tool mode', () => {
  it('buffers below threshold, then flushes all known tasks when it is crossed', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 2);

    await card.onToolStart('c1', 'reading the channel'); // count 1 < 2 → buffered
    expect(chunks).toEqual([]);

    await card.onToolStart('c2', 'searching slack'); // count 2 == threshold → flush both
    expect(chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: 'Reading the channel', status: 'in_progress' },
      { type: 'task_update', id: 'task-2', title: 'Searching slack', status: 'in_progress' },
    ]);
  });

  it('settles a row complete / error on tool end once the card is visible', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    await card.onToolStart('c1', 'reading the channel'); // threshold 1 → visible
    chunks.length = 0;

    await card.onToolEnd('c1', false);
    expect(chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: 'Reading the channel', status: 'complete' },
    ]);

    const second = collector();
    const card2 = new TaskCardManager(second.send, 1);
    await card2.onToolStart('x1', 'fetching the page');
    second.chunks.length = 0;
    await card2.onToolEnd('x1', true);
    expect(second.chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: 'Fetching the page', status: 'error' },
    ]);
  });

  it('touch() re-emits the current rows verbatim to keep the stream warm', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    await card.onToolStart('c1', 'reading the channel'); // visible, in_progress
    await card.onToolEnd('c1', false); // → complete
    await card.onToolStart('c2', 'searching slack'); // still in_progress
    chunks.length = 0;

    await card.touch();
    // Both rows re-sent at their current status, in insertion order — visually
    // idempotent, but a fresh appendStream that resets Slack's idle clock.
    expect(chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: 'Reading the channel', status: 'complete' },
      { type: 'task_update', id: 'task-2', title: 'Searching slack', status: 'in_progress' },
    ]);
  });

  it('touch() is a no-op before the card is visible (nothing to keep warm)', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 2);
    await card.onToolStart('c1', 'reading the channel'); // count 1 < 2 → not visible

    await card.touch();
    expect(send).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
  });

  it('finish() completes a tool row left stuck in_progress', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    await card.onToolStart('c1', 'reading the channel'); // visible, in_progress
    chunks.length = 0;

    await card.finish(); // no onToolEnd fired → auto-complete
    expect(chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: 'Reading the channel', status: 'complete' },
    ]);
  });
});

describe('TaskCardManager — confirmation gate (merged into the tool row)', () => {
  it('shows awaiting → running → complete on the SAME row when approved', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    // Pi emits tool_execution_start (→ onToolStart) BEFORE beforeToolCall, so
    // the row already exists when the gate fires.
    await card.onToolStart('c1', 'posting a message as you'); // task-1, in_progress
    chunks.length = 0;

    await card.onToolGate('c1', 'awaiting', 'posting a message as you');
    expect(chunks).toEqual([
      {
        type: 'task_update',
        id: 'task-1',
        title: 'Posting a message as you — awaiting approval',
        status: 'in_progress',
      },
    ]);
    chunks.length = 0;

    await card.onToolGate('c1', 'approved', 'posting a message as you');
    expect(chunks).toEqual([
      {
        type: 'task_update',
        id: 'task-1',
        title: 'Posting a message as you',
        status: 'in_progress',
      },
    ]);
    chunks.length = 0;

    // The tool then runs to completion — the row settles normally (same id).
    await card.onToolEnd('c1', false);
    expect(chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: 'Posting a message as you', status: 'complete' },
    ]);
  });

  it('settles the row to "denied", preserved through the blocked tool end', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    await card.onToolStart('c1', 'deleting its message'); // task-1
    chunks.length = 0;

    await card.onToolGate('c1', 'awaiting', 'deleting its message');
    await card.onToolGate('c1', 'denied', 'deleting its message');
    // A blocked tool still emits tool_execution_end with isError=true; the
    // "denied" title must survive (onToolEnd keeps the row's title).
    await card.onToolEnd('c1', true);

    expect(chunks[chunks.length - 1]).toEqual({
      type: 'task_update',
      id: 'task-1',
      title: 'Deleting its message — denied',
      status: 'error',
    });
    // Exactly one row id throughout — no duplicate "decision" row.
    expect(new Set(chunks.map((c) => c.id))).toEqual(new Set(['task-1']));
  });

  it('forces the card visible for a gate even below the buffering threshold', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 5); // high threshold → onToolStart buffers
    await card.onToolStart('c1', 'posting a message as you');
    expect(chunks).toEqual([]); // buffered, nothing on the card yet

    await card.onToolGate('c1', 'awaiting', 'posting a message as you');
    expect(chunks).toEqual([
      {
        type: 'task_update',
        id: 'task-1',
        title: 'Posting a message as you — awaiting approval',
        status: 'in_progress',
      },
    ]);
  });

  it('records the gate even in plan mode (where plain tool rows are suppressed)', async () => {
    const { chunks, send } = collector();
    const card = new TaskCardManager(send, 1);
    const plan = new PlanController();
    card.bindPlan(plan);
    await plan.setPlan(['Do the thing']); // plan-mode latches
    chunks.length = 0;

    await card.onToolStart('c1', 'posting a message as you'); // suppressed → []
    expect(chunks).toEqual([]);

    await card.onToolGate('c1', 'awaiting', 'posting a message as you');
    await card.onToolGate('c1', 'denied', 'posting a message as you');

    const last = chunks[chunks.length - 1];
    expect(last?.title).toBe('Posting a message as you — denied');
    expect(last?.status).toBe('error');
  });
});
