import { describe, expect, it } from 'vitest';

import {
  buildResolvedConfirmationMessage,
  formatArgsForConfirmation,
} from '../src/confirmations.js';

import type { SlackBlock } from '@sym/adapter-slack';

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

describe('buildResolvedConfirmationMessage', () => {
  const original: { text: string; blocks: SlackBlock[] } = {
    text: '⚠️ Sym wants to run *set_status* — approve?',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '⚠️ run *set_status*\n```status: busy```' },
      },
      { type: 'actions', elements: [{ type: 'button', action_id: 'sym_confirm:1:approve' }] },
    ],
  };

  it('keeps the question, drops the buttons, and appends an Approved line', () => {
    const { blocks, text } = buildResolvedConfirmationMessage(original, true);
    // The actions (buttons) block is removed.
    expect(blocks.some((b) => (b as { type?: string }).type === 'actions')).toBe(false);
    // The original question section is retained (history shows WHAT was approved).
    expect(blocks[0]).toEqual(original.blocks[0]);
    // The decision is appended as the last block.
    const last = blocks[blocks.length - 1] as { type?: string; elements?: { text?: string }[] };
    expect(last.type).toBe('context');
    expect(last.elements?.[0]?.text).toContain('Approved');
    expect(text).toContain('Approved');
  });

  it('shows Cancelled when denied', () => {
    const { blocks, text } = buildResolvedConfirmationMessage(original, false);
    const last = blocks[blocks.length - 1] as { elements?: { text?: string }[] };
    expect(last.elements?.[0]?.text).toContain('Cancelled');
    expect(text).toContain('Cancelled');
  });

  it('falls back to a section from the message text when blocks are absent', () => {
    const { blocks } = buildResolvedConfirmationMessage({ text: 'do the thing?' }, true);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { type?: string }).type).toBe('section');
    expect((blocks[1] as { type?: string }).type).toBe('context');
  });

  it('produces a bare decision when there is no original content', () => {
    const { blocks } = buildResolvedConfirmationMessage({}, false);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type?: string }).type).toBe('context');
  });
});
