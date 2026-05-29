import { describe, expect, it } from 'vitest';

import { formatArgsForConfirmation } from '../src/confirmations.js';

describe('formatArgsForConfirmation', () => {
  it('always shows the target channel even when the body is huge (audit #4)', () => {
    // Model emits body first, channel_id last — the load-bearing field.
    const out = formatArgsForConfirmation({
      text: 'x'.repeat(5000),
      channel_id: 'C_SECRET',
      thread_ts: '123.45',
    });
    const lines = out.split('\n');
    // Targeting fields pinned to the top and never truncated.
    expect(lines[0]).toBe('channel_id: C_SECRET');
    expect(lines[1]).toBe('thread_ts: 123.45');
    expect(out).toContain('channel_id: C_SECRET');
    // The body is truncated per-field, not by hiding the channel.
    expect(out).toMatch(/text: x+…$/);
  });

  it('keeps each field on its own line and caps only long non-targeting values', () => {
    const out = formatArgsForConfirmation({ channel_id: 'C1', text: 'hello world' });
    expect(out).toBe('channel_id: C1\ntext: hello world');
  });

  it('handles empty args', () => {
    expect(formatArgsForConfirmation({})).toBe('(no arguments)');
  });

  it('orders multiple targeting fields by risk rank, then the rest', () => {
    const out = formatArgsForConfirmation({
      reason: 'because',
      user_id: 'U9',
      channel_id: 'C1',
    });
    expect(out.split('\n')).toEqual(['channel_id: C1', 'user_id: U9', 'reason: because']);
  });
});
