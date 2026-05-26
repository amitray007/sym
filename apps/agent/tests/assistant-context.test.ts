import { describe, expect, it } from 'vitest';

import { createAssistantContextStore } from '../src/assistant-context.js';

describe('createAssistantContextStore', () => {
  it('remember and lookup a viewed channel', () => {
    const store = createAssistantContextStore();
    store.remember('D1', '100.1', 'C777');
    expect(store.lookup('D1', '100.1')).toBe('C777');
  });

  it('returns undefined for an unknown key', () => {
    const store = createAssistantContextStore();
    expect(store.lookup('D1', '100.1')).toBeUndefined();
  });

  it('overwriting with a new channel updates the stored value', () => {
    const store = createAssistantContextStore();
    store.remember('D1', '100.1', 'C777');
    store.remember('D1', '100.1', 'C888');
    expect(store.lookup('D1', '100.1')).toBe('C888');
  });

  it('remember with undefined deletes the key (clear on navigate away)', () => {
    const store = createAssistantContextStore();
    store.remember('D1', '100.1', 'C777');
    store.remember('D1', '100.1', undefined);
    expect(store.lookup('D1', '100.1')).toBeUndefined();
  });

  it('different threads are stored independently', () => {
    const store = createAssistantContextStore();
    store.remember('D1', '100.1', 'C111');
    store.remember('D1', '200.2', 'C222');
    expect(store.lookup('D1', '100.1')).toBe('C111');
    expect(store.lookup('D1', '200.2')).toBe('C222');
  });

  it('different assistant channels are stored independently', () => {
    const store = createAssistantContextStore();
    store.remember('D1', '100.1', 'C111');
    store.remember('D2', '100.1', 'C222');
    expect(store.lookup('D1', '100.1')).toBe('C111');
    expect(store.lookup('D2', '100.1')).toBe('C222');
  });

  it('drops the oldest half when size exceeds max', () => {
    const max = 4;
    const store = createAssistantContextStore(max);
    // Fill to exactly max.
    for (let i = 0; i < max; i++) {
      store.remember('D1', `ts-${i}`, `C${i}`);
    }
    // Adding one more triggers the eviction of the oldest half (2 entries).
    store.remember('D1', `ts-${max}`, `C${max}`);

    // The oldest 2 entries (ts-0, ts-1) should be gone.
    expect(store.lookup('D1', 'ts-0')).toBeUndefined();
    expect(store.lookup('D1', 'ts-1')).toBeUndefined();
    // The newer entries should still be present.
    expect(store.lookup('D1', 'ts-2')).toBe('C2');
    expect(store.lookup('D1', 'ts-3')).toBe('C3');
    expect(store.lookup('D1', `ts-${max}`)).toBe(`C${max}`);
  });
});
