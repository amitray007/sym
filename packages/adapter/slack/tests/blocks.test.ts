import { describe, expect, it } from 'vitest';

import {
  actionsBlock,
  contextBlock,
  dividerBlock,
  headerBlock,
  linkCell,
  markdownBlock,
  markdownBlocks,
  MAX_MARKDOWN_BLOCK_CHARS,
  MAX_BODY_CHARS,
  mrkdwnElement,
  plainTextElement,
  sectionBlock,
} from '../src/blocks.js';

describe('linkCell', () => {
  it('uses the given text as the link label', () => {
    const cell = linkCell('open issue', 'https://x.test/i/1');
    expect(cell.elements[0].elements[0]).toEqual({
      type: 'link',
      url: 'https://x.test/i/1',
      text: 'open issue',
    });
  });
  it('falls back to the URL when text is empty (Slack rejects empty link text)', () => {
    const cell = linkCell('   ', 'https://x.test/i/1');
    expect(cell.elements[0].elements[0].text).toBe('https://x.test/i/1');
  });
});

describe('markdownBlock', () => {
  it('produces correct shape', () => {
    expect(markdownBlock('**hello**')).toEqual({ type: 'markdown', text: '**hello**' });
  });
});

describe('sectionBlock', () => {
  it('produces correct shape without fields', () => {
    expect(sectionBlock('some text')).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'some text' },
    });
  });

  it('includes fields when provided', () => {
    const fields = [mrkdwnElement('*field1*'), mrkdwnElement('*field2*')];
    const block = sectionBlock('text', fields);
    expect(block.fields).toEqual(fields);
  });
});

describe('headerBlock', () => {
  it('produces correct shape', () => {
    expect(headerBlock('My Title')).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: 'My Title', emoji: true },
    });
  });
});

describe('contextBlock', () => {
  it('produces correct shape', () => {
    const elements = [mrkdwnElement('_model:_ gpt-4'), mrkdwnElement('_tokens:_ 123')];
    expect(contextBlock(elements)).toEqual({ type: 'context', elements });
  });
});

describe('dividerBlock', () => {
  it('produces correct shape', () => {
    expect(dividerBlock()).toEqual({ type: 'divider' });
  });
});

describe('actionsBlock', () => {
  it('produces correct shape', () => {
    const btn = { type: 'button', text: plainTextElement('Click'), action_id: 'my_btn' };
    expect(actionsBlock([btn])).toEqual({ type: 'actions', elements: [btn] });
  });
});

describe('mrkdwnElement', () => {
  it('produces correct shape', () => {
    expect(mrkdwnElement('*bold*')).toEqual({ type: 'mrkdwn', text: '*bold*' });
  });
});

describe('plainTextElement', () => {
  it('produces correct shape with default emoji true', () => {
    expect(plainTextElement('Click me')).toEqual({
      type: 'plain_text',
      text: 'Click me',
      emoji: true,
    });
  });

  it('respects explicit emoji false', () => {
    expect(plainTextElement('No emoji', false)).toEqual({
      type: 'plain_text',
      text: 'No emoji',
      emoji: false,
    });
  });
});

describe('markdownBlocks (chunking)', () => {
  it('returns a single block for short text', () => {
    const b = markdownBlocks('hello');
    expect(b).toEqual([{ type: 'markdown', text: 'hello' }]);
  });

  it('splits a long body into multiple blocks, each under the limit', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const b = markdownBlocks(body);
    expect(b.length).toBeGreaterThan(1);
    for (const blk of b) {
      expect(blk.type).toBe('markdown');
      expect(blk.text.length).toBeLessThanOrEqual(MAX_MARKDOWN_BLOCK_CHARS);
    }
  });

  it('caps total length and marks the truncation', () => {
    const body = 'x'.repeat(MAX_BODY_CHARS + 50_000);
    const b = markdownBlocks(body);
    const total = b.reduce((n, blk) => n + blk.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_BODY_CHARS + 200);
    expect(b[b.length - 1]!.text).toMatch(/truncated/);
  });
});
