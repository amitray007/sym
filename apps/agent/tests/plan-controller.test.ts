/**
 * Unit tests for the per-turn PlanController — the model-authored counterpart
 * to the tool-call-driven task card.
 *
 * Covers the latch, idempotency, emission order, and the failure paths
 * (empty plan, unknown id, no plan). Renderer wiring (TaskCardManager.bindPlan)
 * is tested separately via the handle-turn integration tests.
 */

import { describe, expect, it } from 'vitest';

import { PlanController, type PlanEvent, type PlanItemStatus } from '../src/plan-controller.js';

function captureEvents(controller: PlanController): PlanEvent[] {
  const events: PlanEvent[] = [];
  controller.subscribe((e) => {
    events.push(e);
  });
  return events;
}

describe('PlanController.setPlan', () => {
  it('returns ids in insertion order and emits a set_plan event', async () => {
    const c = new PlanController();
    const events = captureEvents(c);

    const result = await c.setPlan(['Find incident', 'Summarize', 'Set reminder']);

    expect(result.ok).toBe(true);
    expect(result.ids).toEqual(['p1', 'p2', 'p3']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'set_plan',
      items: [
        { id: 'p1', title: 'Find incident', status: 'pending' },
        { id: 'p2', title: 'Summarize', status: 'pending' },
        { id: 'p3', title: 'Set reminder', status: 'pending' },
      ],
    });
  });

  it('engages plan-mode on first call', async () => {
    const c = new PlanController();
    expect(c.isActive()).toBe(false);
    await c.setPlan(['One']);
    expect(c.isActive()).toBe(true);
  });

  it('is idempotent — second call returns already_planned without emitting', async () => {
    const c = new PlanController();
    const events = captureEvents(c);

    await c.setPlan(['First plan']);
    const second = await c.setPlan(['Different plan']);

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already_planned');
    expect(second.ids).toEqual([]);
    // Only the first call emitted.
    expect(events).toHaveLength(1);
    // State unchanged.
    expect(c.snapshot()).toEqual([{ id: 'p1', title: 'First plan', status: 'pending' }]);
  });

  it('rejects an empty plan (all-whitespace items collapse to empty)', async () => {
    const c = new PlanController();
    const events = captureEvents(c);

    const result = await c.setPlan(['  ', '\t']);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
    expect(events).toHaveLength(0);
    expect(c.isActive()).toBe(false);
  });

  it('trims whitespace from item titles', async () => {
    const c = new PlanController();
    await c.setPlan(['  Find incident  ', 'Summarize']);
    expect(c.snapshot()[0]?.title).toBe('Find incident');
  });

  it('drops empty/whitespace items but keeps the rest', async () => {
    const c = new PlanController();
    const result = await c.setPlan(['Real item', '   ', 'Another real item']);
    expect(result.ids).toEqual(['p1', 'p2']);
    expect(c.snapshot().map((i) => i.title)).toEqual(['Real item', 'Another real item']);
  });
});

describe('PlanController.updateTask', () => {
  it('flips an item status and emits an update_task event', async () => {
    const c = new PlanController();
    await c.setPlan(['One', 'Two']);
    const events = captureEvents(c); // Subscribe AFTER setPlan to isolate updates.

    const result = await c.updateTask('p2', 'in_progress');

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'update_task',
      item: { id: 'p2', title: 'Two', status: 'in_progress' },
    });
    expect(c.snapshot()[1]?.status).toBe('in_progress');
  });

  it('records a note when supplied (typical for blocked)', async () => {
    const c = new PlanController();
    await c.setPlan(['One']);
    const events = captureEvents(c);

    await c.updateTask('p1', 'blocked', 'Need the doc link');

    expect(events[0]).toMatchObject({
      type: 'update_task',
      item: { id: 'p1', status: 'blocked', note: 'Need the doc link' },
    });
  });

  it('ignores empty-string notes (treated as absent)', async () => {
    const c = new PlanController();
    await c.setPlan(['One']);
    await c.updateTask('p1', 'complete', '');
    expect(c.snapshot()[0]?.note).toBeUndefined();
  });

  it('fails with no_plan if setPlan was never called', async () => {
    const c = new PlanController();
    const result = await c.updateTask('p1', 'complete');
    expect(result).toEqual({ ok: false, reason: 'no_plan' });
  });

  it('fails with unknown_id when the id does not match', async () => {
    const c = new PlanController();
    await c.setPlan(['One']);
    const result = await c.updateTask('p99', 'complete');
    expect(result).toEqual({ ok: false, reason: 'unknown_id' });
  });

  it('supports the full status enum', async () => {
    const c = new PlanController();
    await c.setPlan(['One']);
    const statuses: PlanItemStatus[] = ['pending', 'in_progress', 'complete', 'blocked'];
    for (const s of statuses) {
      const r = await c.updateTask('p1', s);
      expect(r.ok).toBe(true);
    }
    expect(c.snapshot()[0]?.status).toBe('blocked');
  });
});

describe('PlanController subscribers', () => {
  it('runs all listeners in subscription order', async () => {
    const c = new PlanController();
    const calls: string[] = [];
    c.subscribe(() => {
      calls.push('a');
    });
    c.subscribe(() => {
      calls.push('b');
    });
    await c.setPlan(['One']);
    expect(calls).toEqual(['a', 'b']);
  });

  it('continues to subsequent listeners if one throws', async () => {
    const c = new PlanController();
    const calls: string[] = [];
    c.subscribe(() => {
      throw new Error('boom');
    });
    c.subscribe(() => {
      calls.push('b');
    });
    await c.setPlan(['One']);
    expect(calls).toEqual(['b']);
  });
});
