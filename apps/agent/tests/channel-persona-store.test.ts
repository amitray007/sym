/**
 * ChannelPersonaStore — the unencrypted per-channel home-voice store. Uses an
 * in-memory DB so each test is isolated and leaves no file behind.
 */

import { afterEach, describe, expect, it } from 'vitest';

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
