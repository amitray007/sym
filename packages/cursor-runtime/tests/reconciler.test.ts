import { describe, expect, it, vi } from 'vitest';

import { CursorClientError } from '../src/client.js';
import { CloudRunReconciler, type CloudRunPoller } from '../src/reconciler.js';
import { CloudRunStore } from '../src/store.js';

import type { CloudRunRecord, CloudRunView } from '../src/types.js';

interface Harness {
  store: CloudRunStore;
  rec: CloudRunReconciler;
  delivered: CloudRunRecord[];
}

function setup(
  opts: {
    getRun?: CloudRunPoller['getRun'];
    onTransition?: (r: CloudRunRecord) => void | Promise<void>;
    now?: () => number;
    graceMs?: number;
    prGraceMs?: number;
    maxRunMs?: number;
  } = {},
): Harness {
  const store = new CloudRunStore({ dbPath: ':memory:', ...(opts.now ? { now: opts.now } : {}) });
  const delivered: CloudRunRecord[] = [];
  const rec = new CloudRunReconciler({
    client: { getRun: opts.getRun ?? (async () => ({ status: 'running', pendingPr: false })) },
    store,
    onTransition: opts.onTransition ?? ((r) => void delivered.push(r)),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
    ...(opts.prGraceMs !== undefined ? { prGraceMs: opts.prGraceMs } : {}),
    ...(opts.maxRunMs !== undefined ? { maxRunMs: opts.maxRunMs } : {}),
  });
  return { store, rec, delivered };
}

const running = (store: CloudRunStore, dispatchId: string, runId = 'r1'): void => {
  store.insertIntent({ dispatchId, channel: 'C', threadTs: 'T' });
  store.patchDispatched(dispatchId, { runId, agentId: 'a1' });
};

const finishedPr = (): Promise<CloudRunView> =>
  Promise.resolve({ status: 'finished', prUrl: 'https://pr/1', summary: 's', pendingPr: false });

describe('CloudRunReconciler', () => {
  it('delivers a finished run with a PR exactly once', async () => {
    const { store, rec, delivered } = setup({ getRun: finishedPr });
    running(store, 'd1');

    await rec.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.prUrl).toBe('https://pr/1');
    expect(store.get('d1')?.deliveredAt).toBeDefined();

    await rec.tick();
    expect(delivered).toHaveLength(1); // no double delivery
  });

  it('does not deliver a still-running run', async () => {
    const { store, rec, delivered } = setup({
      getRun: async () => ({ status: 'running', pendingPr: false }),
    });
    running(store, 'd1');
    await rec.tick();
    expect(delivered).toHaveLength(0);
    expect(store.get('d1')?.status).toBe('running');
  });

  it('delivers a cancelled run as terminal', async () => {
    const { store, rec, delivered } = setup({
      getRun: async () => ({ status: 'cancelled', pendingPr: false }),
    });
    running(store, 'd1');
    await rec.tick();
    expect(store.get('d1')?.status).toBe('cancelled');
    expect(delivered).toHaveLength(1);
  });

  it('fails a stuck dispatching row only after the grace window', async () => {
    let t = 1000;
    const { store, rec, delivered } = setup({ now: () => t, graceMs: 500 });
    store.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' }); // createdAt 1000

    t = 1400;
    await rec.tick();
    expect(store.get('d1')?.status).toBe('dispatching');
    expect(delivered).toHaveLength(0);

    t = 1600;
    await rec.tick();
    expect(store.get('d1')?.status).toBe('error');
    expect(delivered).toHaveLength(1);
  });

  it('anchors the PR wait at first finished-pending observation, then delivers no-PR after grace', async () => {
    let t = 1000;
    const { store, rec, delivered } = setup({
      now: () => t,
      prGraceMs: 500,
      getRun: async () => ({ status: 'finished', pendingPr: true }),
    });
    running(store, 'd1'); // updatedAt anchored at 1000 — must NOT be the wait anchor

    t = 1400;
    await rec.tick();
    expect(delivered).toHaveLength(0); // first observation anchors pendingSince, no delivery
    expect(store.get('d1')?.pendingSince).toBe(1400);

    t = 1700; // 300ms since pendingSince — still within grace
    await rec.tick();
    expect(delivered).toHaveLength(0);

    t = 2000; // 600ms since pendingSince — past grace
    await rec.tick();
    expect(delivered).toHaveLength(1);
    expect(store.get('d1')?.status).toBe('finished');
    expect(store.get('d1')?.statusText).toBe('finished (no PR)');
  });

  it('delivers WITH the PR url once it appears after a pending wait', async () => {
    let pending = true;
    const { store, rec, delivered } = setup({
      getRun: async () =>
        pending
          ? { status: 'finished', pendingPr: true }
          : { status: 'finished', prUrl: 'https://pr/9', pendingPr: false },
    });
    running(store, 'd1');

    await rec.tick(); // observes pending → anchors, no delivery
    expect(delivered).toHaveLength(0);

    pending = false;
    await rec.tick(); // PR has arrived → delivers WITH the url
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.prUrl).toBe('https://pr/9');
    expect(store.get('d1')?.prUrl).toBe('https://pr/9');
  });

  it('delivers an immediately-finished run with no PR (pendingPr false)', async () => {
    const { store, rec, delivered } = setup({
      getRun: async () => ({ status: 'finished', pendingPr: false }),
    });
    running(store, 'd1');
    await rec.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.statusText).toBe('finished (no PR)');
    expect(delivered[0]?.prUrl).toBeUndefined();
  });

  it('fails a run that exceeds the max-run deadline', async () => {
    let t = 1000;
    const { store, rec, delivered } = setup({
      now: () => t,
      maxRunMs: 500,
      getRun: async () => ({ status: 'running', pendingPr: false }),
    });
    running(store, 'd1'); // createdAt 1000
    t = 1600; // 600ms > 500
    await rec.tick();
    expect(store.get('d1')?.status).toBe('error');
    expect(store.get('d1')?.statusText).toBe('timed out');
    expect(delivered).toHaveLength(1);
  });

  it('does not double-deliver when a slow tick overlaps the next (reentrancy guard)', async () => {
    let resolvePost: (() => void) | undefined;
    const { store, rec, delivered } = setup({
      getRun: finishedPr,
      onTransition: (r) =>
        new Promise<void>((resolve) => {
          delivered.push(r);
          resolvePost = resolve;
        }),
    });
    running(store, 'd1');

    const first = rec.tick(); // enters onTransition, awaits resolvePost
    await rec.tick(); // overlapping tick must be a no-op (guard)
    expect(delivered).toHaveLength(1);
    resolvePost?.();
    await first;
    expect(delivered).toHaveLength(1);
  });

  it('drains a running row missing run ids instead of looping forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, rec, delivered } = setup({ getRun: finishedPr });
    store.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    store.markStatus('d1', 'running'); // running but never patched with ids
    await rec.tick();
    expect(store.get('d1')?.status).toBe('error');
    expect(delivered).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('marks a run error on a non-retryable poll failure', async () => {
    const { store, rec, delivered } = setup({
      getRun: async () => {
        throw new CursorClientError('auth failed', { code: 'auth', retryable: false });
      },
    });
    running(store, 'd1');
    await rec.tick();
    expect(store.get('d1')?.status).toBe('error');
    expect(delivered).toHaveLength(1);
  });

  it('retries a run after a retryable poll failure (does not deliver)', async () => {
    let calls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, rec, delivered } = setup({
      getRun: async () => {
        calls += 1;
        if (calls === 1) throw new CursorClientError('net', { code: 'network', retryable: true });
        return finishedPr();
      },
    });
    running(store, 'd1');

    await rec.tick();
    expect(delivered).toHaveLength(0);
    expect(store.get('d1')?.status).toBe('running');

    await rec.tick();
    expect(delivered).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('retries delivery when onTransition throws (notification not lost)', async () => {
    let fail = true;
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, rec } = setup({
      getRun: finishedPr,
      onTransition: (r) => {
        if (fail) {
          fail = false;
          throw new Error('slack down');
        }
        seen.push(r.dispatchId);
      },
    });
    running(store, 'd1');

    await rec.tick();
    expect(store.get('d1')?.deliveredAt).toBeUndefined();
    expect(store.get('d1')?.status).toBe('finished');

    await rec.tick();
    expect(seen).toEqual(['d1']);
    expect(store.get('d1')?.deliveredAt).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('isolates a failing run from the rest of the batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, rec, delivered } = setup({
      getRun: async (_agentId, runId) => {
        if (runId === 'bad') throw new Error('boom');
        return finishedPr();
      },
    });
    running(store, 'bad', 'bad');
    running(store, 'good', 'good');

    await rec.tick();
    expect(delivered.map((r) => r.dispatchId)).toEqual(['good']); // only good delivered
    expect(store.get('bad')?.status).toBe('running'); // bad survives, retried later
    expect(store.get('bad')?.deliveredAt).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('start/stop use the injected timer seam and start is idempotent', () => {
    const store = new CloudRunStore({ dbPath: ':memory:' });
    let scheduled: (() => void) | undefined;
    let scheduleCount = 0;
    let cleared = false;
    const rec = new CloudRunReconciler({
      client: { getRun: async () => ({ status: 'running', pendingPr: false }) },
      store,
      onTransition: () => undefined,
      setIntervalFn: (fn) => {
        scheduled = fn;
        scheduleCount += 1;
        return 'handle';
      },
      clearIntervalFn: (h) => {
        cleared = h === 'handle';
      },
    });

    rec.start();
    rec.start(); // idempotent
    expect(scheduleCount).toBe(1);
    expect(scheduled).toBeTypeOf('function');
    rec.stop();
    expect(cleared).toBe(true);
    store.close();
  });
});
