/**
 * Hermetic unit tests for retry backoff math.
 * No database needed.
 */

import { describe, expect, it } from 'vitest';

import { backoffSeconds } from './retry.js';

describe('backoffSeconds', () => {
  it('returns 30s for attempt 1', () => {
    expect(backoffSeconds(1)).toBe(30);
  });

  it('returns 60s for attempt 2', () => {
    expect(backoffSeconds(2)).toBe(60);
  });

  it('returns 120s for attempt 3', () => {
    expect(backoffSeconds(3)).toBe(120);
  });

  it('returns 240s for attempt 4', () => {
    expect(backoffSeconds(4)).toBe(240);
  });

  it('caps at 300s for attempt 5+', () => {
    expect(backoffSeconds(5)).toBe(300);
    expect(backoffSeconds(6)).toBe(300);
    expect(backoffSeconds(10)).toBe(300);
  });

  it('never returns a negative value for attempt 0', () => {
    // attempt 0 → base * 2^(-1) = 15s — still positive and below cap
    expect(backoffSeconds(0)).toBeGreaterThan(0);
  });
});
