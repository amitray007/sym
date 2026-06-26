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

  it('waits for the PR url, then delivers finished-without-PR after the grace', async () => {
    let t = 1000;
    const { store, rec, delivered } = setup({
      now: () => t,
      prGraceMs: 500,
      getRun: async () => ({ status: 'finished', pendingPr: true }),
    });
    running(store, 'd1'); // updatedAt 1000

    t = 1400;
    await rec.tick();
    expect(delivered).toHaveLength(0); // still waiting for the PR

    t = 1600;
    await rec.tick();
    expect(delivered).toHaveLength(1);
    expect(store.get('d1')?.status).toBe('finished');
    expect(store.get('d1')?.statusText).toBe('finished (no PR)');
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
    expect(delivered.map((r) => r.dispatchId)).toContain('good');
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
