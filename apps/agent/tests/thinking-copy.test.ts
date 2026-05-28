/**
 * Unit tests for the shimmer-phrase rotation.
 *
 * Two properties to pin: determinism (same turn id → same phrase) and
 * coverage (varying turn ids surface multiple distinct phrases across a
 * reasonable sample). Tone / voice review lives in the source comments,
 * not here.
 */

import { describe, expect, it } from 'vitest';

import { pickShimmerPhrase, pickShimmerStatus, SHIMMER_PHRASES } from '../src/thinking-copy.js';

import type { TurnId } from '@sym/contracts';

describe('pickShimmerPhrase', () => {
  it('always returns a value from the curated list', () => {
    const sample = ['t-1', 't-2', 't-abc', 'turn_xyz', 'long-turn-id-9000'];
    const set = new Set<string>(SHIMMER_PHRASES);
    for (const id of sample) {
      expect(set.has(pickShimmerPhrase(id as TurnId))).toBe(true);
    }
  });

  it('is deterministic — same id maps to the same phrase', () => {
    const a = pickShimmerPhrase('turn-42' as TurnId);
    const b = pickShimmerPhrase('turn-42' as TurnId);
    expect(a).toBe(b);
  });

  it('falls back to the first entry on undefined/empty', () => {
    expect(pickShimmerPhrase(undefined)).toBe(SHIMMER_PHRASES[0]);
    expect(pickShimmerPhrase('')).toBe(SHIMMER_PHRASES[0]);
  });

  it('surfaces at least 4 distinct phrases across 60 unique ids', () => {
    // Sanity bound on the hash distribution — too few buckets would mean the
    // rotation effectively stops rotating.
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      seen.add(pickShimmerPhrase(`turn-${i}` as TurnId));
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe('pickShimmerStatus', () => {
  it('wraps the phrase in the "is X…" template', () => {
    const status = pickShimmerStatus('turn-1' as TurnId);
    expect(status.startsWith('is ')).toBe(true);
    expect(status.endsWith('…')).toBe(true);
  });

  it('matches the unwrapped phrase from pickShimmerPhrase for the same id', () => {
    const id = 'turn-99' as TurnId;
    expect(pickShimmerStatus(id)).toBe(`is ${pickShimmerPhrase(id)}…`);
  });
});

describe('SHIMMER_PHRASES shape', () => {
  it('has at least 6 entries (otherwise rotation feels canned)', () => {
    expect(SHIMMER_PHRASES.length).toBeGreaterThanOrEqual(6);
  });

  it('contains no duplicates', () => {
    expect(new Set(SHIMMER_PHRASES).size).toBe(SHIMMER_PHRASES.length);
  });

  it('entries are short — 1 to 4 words each', () => {
    for (const entry of SHIMMER_PHRASES) {
      const wc = entry.trim().split(/\s+/).length;
      expect(wc, `entry "${entry}" word count`).toBeGreaterThanOrEqual(1);
      expect(wc, `entry "${entry}" word count`).toBeLessThanOrEqual(4);
    }
  });

  it('entries are lowercase (so they read naturally after "is ")', () => {
    for (const entry of SHIMMER_PHRASES) {
      // First letter lowercase — "is Cooking…" reads off; "is cooking…" reads right.
      const first = entry.trim().charAt(0);
      expect(first, `entry "${entry}" first letter`).toBe(first.toLowerCase());
    }
  });

  it('entries contain no punctuation that reads as exclamation/excitement', () => {
    for (const entry of SHIMMER_PHRASES) {
      expect(entry, `entry "${entry}" should not exclaim`).not.toMatch(/[!?]/);
    }
  });

  it('includes "thinking" as a baseline option', () => {
    expect(SHIMMER_PHRASES).toContain('thinking');
  });
});
