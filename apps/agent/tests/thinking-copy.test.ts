/**
 * Unit tests for the prelude-copy rotation.
 *
 * Two properties to pin: determinism (same turn id → same word) and coverage
 * (varying turn ids surface multiple distinct words across a reasonable
 * sample). Tone / voice review lives in the source comments, not here.
 */

import { describe, expect, it } from 'vitest';

import { pickThinkingCopy, THINKING_COPY } from '../src/thinking-copy.js';

import type { TurnId } from '@sym/contracts';

describe('pickThinkingCopy', () => {
  it('always returns a value from the curated list', () => {
    const sample = ['t-1', 't-2', 't-abc', 'turn_xyz', 'long-turn-id-9000'];
    const set = new Set<string>(THINKING_COPY);
    for (const id of sample) {
      expect(set.has(pickThinkingCopy(id as TurnId))).toBe(true);
    }
  });

  it('is deterministic — same id maps to the same word', () => {
    const a = pickThinkingCopy('turn-42' as TurnId);
    const b = pickThinkingCopy('turn-42' as TurnId);
    expect(a).toBe(b);
  });

  it('falls back to the first entry on undefined/empty', () => {
    expect(pickThinkingCopy(undefined)).toBe(THINKING_COPY[0]);
    expect(pickThinkingCopy('')).toBe(THINKING_COPY[0]);
  });

  it('surfaces at least 3 distinct words across 50 unique ids', () => {
    // Sanity bound on the hash distribution — too few buckets would mean the
    // rotation effectively stops rotating.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(pickThinkingCopy(`turn-${i}` as TurnId));
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe('THINKING_COPY shape', () => {
  it('has at least 4 entries (otherwise rotation feels canned)', () => {
    expect(THINKING_COPY.length).toBeGreaterThanOrEqual(4);
  });

  it('contains no duplicates', () => {
    expect(new Set(THINKING_COPY).size).toBe(THINKING_COPY.length);
  });

  it('entries are short — 1 to 4 words each', () => {
    for (const entry of THINKING_COPY) {
      const wc = entry.trim().split(/\s+/).length;
      expect(wc, `entry "${entry}" word count`).toBeGreaterThanOrEqual(1);
      expect(wc, `entry "${entry}" word count`).toBeLessThanOrEqual(4);
    }
  });

  it('entries contain no punctuation that reads as exclamation/excitement', () => {
    for (const entry of THINKING_COPY) {
      expect(entry, `entry "${entry}" should not exclaim`).not.toMatch(/[!?]/);
    }
  });
});
