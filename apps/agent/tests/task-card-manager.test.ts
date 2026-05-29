import { describe, expect, it, vi } from 'vitest';

import { TaskCardManager } from '../src/handle-turn.js';
import { PlanController } from '../src/plan-controller.js';

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
