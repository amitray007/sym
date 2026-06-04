import { describe, expect, it, vi } from 'vitest';

import { recordGenAiUsage, withSpan } from '../src/telemetry.js';

// The default (no SDK registered) tracer is a no-op, so these exercise the
// wrapper logic without needing an OpenTelemetry SDK.
describe('withSpan', () => {
  it('returns the wrapped function result', async () => {
    const result = await withSpan('test.span', { 'app.k': 'v' }, async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors from the wrapped function', async () => {
    await expect(
      withSpan('test.span', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('runs the wrapped function exactly once', async () => {
    const fn = vi.fn(async () => 'ok');
    await withSpan('test.span', {}, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('recordGenAiUsage', () => {
  it('never throws — no usage, or no active span', () => {
    expect(() => recordGenAiUsage(undefined)).not.toThrow();
    expect(() =>
      recordGenAiUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
    ).not.toThrow();
  });
});
