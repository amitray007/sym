/**
 * ChannelPersonaStore — the unencrypted per-channel home-voice store. Uses an
 * in-memory DB so each test is isolated and leaves no file behind.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelPersonaStore } from '@sym/mcp-runtime';

describe('ChannelPersonaStore', () => {
  let store: ChannelPersonaStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  function fresh(): ChannelPersonaStore {
    store = new ChannelPersonaStore(':memory:');
    return store;
  }

  it('returns undefined for an unknown channel', () => {
    expect(fresh().get('C_unknown')).toBeUndefined();
  });

  it('sets and reads back a channel override', () => {
    const s = fresh();
    s.set('C_eng', 'goblin');
    expect(s.get('C_eng')).toBe('goblin');
  });

  it('replaces an existing override (upsert, one row)', () => {
    const s = fresh();
    s.set('C_eng', 'goblin');
    s.set('C_eng', 'operator');
    expect(s.get('C_eng')).toBe('operator');
    expect(s.list()).toHaveLength(1);
  });

  it('removes an override and reports whether a row existed', () => {
    const s = fresh();
    s.set('C_eng', 'goblin');
    expect(s.remove('C_eng')).toBe(true);
    expect(s.get('C_eng')).toBeUndefined();
    expect(s.remove('C_eng')).toBe(false);
  });

  it('lists all overrides with a numeric updatedAt', () => {
    const s = fresh();
    s.set('C_eng', 'goblin');
    s.set('C_exec', 'concierge');
    const list = s.list();
    expect(list).toHaveLength(2);
    expect(list.map((o) => o.channelId).sort()).toEqual(['C_eng', 'C_exec']);
    for (const o of list) expect(typeof o.updatedAt).toBe('number');
  });

  it('stores persona ids verbatim — validation is the reader’s job', () => {
    const s = fresh();
    s.set('C_eng', 'not-a-real-voice');
    expect(s.get('C_eng')).toBe('not-a-real-voice');
  });
});

// On a REAL file across two connections — the contract the store is built around
// (the long-lived agent reads what the short-lived `sym` CLI process wrote). The
// :memory: tests above can't exercise this: an in-memory DB is private per
// connection, so the mkdir/chmod/busy_timeout real-file paths never run there.
describe('ChannelPersonaStore — on-disk, cross-connection (agent reads / CLI writes)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sym-settings-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second connection reads a value the first wrote + committed (and creates a missing parent dir)', () => {
    const path = join(dir, 'nested', 'settings.db'); // nested → exercises mkdirSync of the parent
    const writer = new ChannelPersonaStore(path);
    writer.set('C0EXEC1234', 'concierge');
    writer.close();

    const reader = new ChannelPersonaStore(path);
    try {
      expect(reader.get('C0EXEC1234')).toBe('concierge');
    } finally {
      reader.close();
    }
  });

  it('an already-open reader sees a later write committed by a separate connection (no stale snapshot)', () => {
    const path = join(dir, 'settings.db');
    const reader = new ChannelPersonaStore(path);
    const writer = new ChannelPersonaStore(path);
    try {
      expect(reader.get('C0ENG5678')).toBeUndefined();
      writer.set('C0ENG5678', 'goblin'); // committed on the writer connection
      // The reader's next .get() runs in a fresh implicit read txn → sees the commit.
      expect(reader.get('C0ENG5678')).toBe('goblin');
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('locks the db file to owner-only (0600) on a real path', () => {
    const path = join(dir, 'settings.db');
    const s = new ChannelPersonaStore(path);
    try {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600); // chmodSync in the constructor
    } finally {
      s.close();
    }
  });
});
