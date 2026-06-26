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

  it('preserves a prior prUrl across a later markStatus without one (COALESCE)', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    s.markStatus('d1', 'finished', { prUrl: 'https://pr/1' });
    s.markStatus('d1', 'finished', { statusText: 'update only' });
    const rec = s.get('d1');
    expect(rec?.prUrl).toBe('https://pr/1');
    expect(rec?.statusText).toBe('update only');
    s.close();
  });

  it('returns active rows oldest-first without the caller sorting', () => {
    let t = 0;
    const s = new CloudRunStore({ dbPath: ':memory:', now: () => t });
    t = 300;
    s.insertIntent({ dispatchId: 'late', channel: 'C', threadTs: 'T' });
    t = 100;
    s.insertIntent({ dispatchId: 'early', channel: 'C', threadTs: 'T' });
    expect(s.listActive().map((r) => r.dispatchId)).toEqual(['early', 'late']);
    s.close();
  });

  it('markStatus on an unknown dispatchId is a silent no-op', () => {
    const s = makeStore();
    expect(() => s.markStatus('nope', 'finished')).not.toThrow();
    expect(s.get('nope')).toBeUndefined();
    s.close();
  });

  it('getByRunId returns undefined for a dispatching row (null run_id)', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    expect(s.getByRunId('d1')).toBeUndefined();
    s.close();
  });

  it('patchDispatched will not resurrect a row that already left dispatching', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    s.markStatus('d1', 'error', { statusText: 'dispatch never confirmed' }); // grace fired
    const patched = s.patchDispatched('d1', { runId: 'r1', agentId: 'a1' });
    expect(patched).toBe(false);
    expect(s.get('d1')?.status).toBe('error');
    expect(s.get('d1')?.runId).toBeUndefined();
    s.close();
  });

  it('markPendingSince anchors once and is idempotent', () => {
    const s = makeStore();
    s.insertIntent({ dispatchId: 'd1', channel: 'C', threadTs: 'T' });
    s.markPendingSince('d1', 1500);
    expect(s.get('d1')?.pendingSince).toBe(1500);
    s.markPendingSince('d1', 9999);
    expect(s.get('d1')?.pendingSince).toBe(1500);
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
