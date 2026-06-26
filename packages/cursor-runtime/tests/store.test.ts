import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CloudRunStore } from '../src/store.js';

const makeStore = (now: () => number = () => 1000): CloudRunStore =>
  new CloudRunStore({ dbPath: ':memory:', now });

describe('CloudRunStore', () => {
  it('inserts an intent row as dispatching with no runId', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    const rec = s.get('d1');
    expect(rec?.status).toBe('dispatching');
    expect(rec?.runId).toBeUndefined();
    expect(rec?.channel).toBe('C');
    expect(rec?.threadTs).toBe('T');
    expect(rec?.createdAt).toBe(1000);
    s.close();
  });

  it('patches dispatched ids and flips to running', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    s.patchDispatched('d1', { runId: 'r1', agentId: 'a1' });
    const rec = s.get('d1');
    expect(rec?.status).toBe('running');
    expect(rec?.runId).toBe('r1');
    expect(rec?.agentId).toBe('a1');
    expect(s.getByRunId('r1')?.dispatchId).toBe('d1');
    s.close();
  });

  it('markStatus then markDelivered sets prUrl and deliveredAt', () => {
    let t = 1000;
    const s = new CloudRunStore({ dbPath: ':memory:', now: () => t });
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    s.patchDispatched('d1', { runId: 'r1', agentId: 'a1' });
    t = 2000;
    s.markStatus('d1', 'finished', { statusText: 'opened PR', prUrl: 'https://pr/1' });
    const mid = s.get('d1');
    expect(mid?.status).toBe('finished');
    expect(mid?.prUrl).toBe('https://pr/1');
    expect(mid?.statusText).toBe('opened PR');
    expect(mid?.deliveredAt).toBeUndefined();
    t = 3000;
    s.markDelivered('d1');
    expect(s.get('d1')?.deliveredAt).toBe(3000);
    s.close();
  });

  it('listActive includes dispatching/running/undelivered-terminal, excludes delivered', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'dispatching', channel: 'C', threadTs: 'T' });
    s.insertIntent({ dispatchId: 'running', channel: 'C', threadTs: 'T' });
    s.patchDispatched('running', { runId: 'r', agentId: 'a' });
    s.insertIntent({ dispatchId: 'undelivered', channel: 'C', threadTs: 'T' });
    s.markStatus('undelivered', 'finished');
    s.insertIntent({ dispatchId: 'delivered', channel: 'C', threadTs: 'T' });
    s.markStatus('delivered', 'finished');
    s.markDelivered('delivered');

    const ids = s
      .listActive()
      .map((r) => r.dispatchId)
      .sort();
    expect(ids).toEqual(['dispatching', 'running', 'undelivered']);
    s.close();
  });

  it('rejects a duplicate dispatchId', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    expect(() => s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' })).toThrow();
    s.close();
  });

  it('persists active rows across store instances (R7 resume)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudrun-'));
    const dbPath = join(dir, 'cloud.db');
    try {
      const s1 = new CloudRunStore({ dbPath, now: () => 1000 });
      s1.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
      s1.patchDispatched('d1', { runId: 'r1', agentId: 'a1' });
      s1.close();

      const s2 = new CloudRunStore({ dbPath, now: () => 2000 });
      expect(s2.listActive().map((r) => r.dispatchId)).toEqual(['d1']);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
