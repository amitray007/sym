import { describe, expect, it } from 'vitest';

import { renderIntentToBlocks, renderIntentToFallbackText } from '../src/render.js';

import type { TableRenderIntent } from '@sym/contracts';

const table: TableRenderIntent = {
  kind: 'table',
  columns: [{ header: 'From' }, { header: 'Channel' }, { header: 'Message', align: 'left' }],
  rows: [
    [{ text: 'Amit' }, { text: '#launch' }, { text: 'GA is Thursday', link: 'https://x/1' }],
    [{ text: 'Priya' }, { text: '#eng' }, { text: 'no link here' }],
  ],
};

describe('renderIntentToBlocks (table)', () => {
  it('emits a single table block with a header row first', () => {
    const blocks = renderIntentToBlocks(table);
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.type).toBe('table');
    if (block.type !== 'table') throw new Error('expected table');
    // header + 2 data rows
    expect(block.rows).toHaveLength(3);
    expect(block.rows[0]).toEqual([
      { type: 'raw_text', text: 'From' },
      { type: 'raw_text', text: 'Channel' },
      { type: 'raw_text', text: 'Message' },
    ]);
  });

  it('renders a cell with a link as a rich_text link cell', () => {
    const block = renderIntentToBlocks(table)[0]!;
    if (block.type !== 'table') throw new Error('expected table');
    const linked = block.rows[1]![2]!;
    expect(linked).toEqual({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'link', url: 'https://x/1', text: 'GA is Thursday' }],
        },
      ],
    });
  });

  it('renders a linkless cell as raw_text', () => {
    const block = renderIntentToBlocks(table)[0]!;
    if (block.type !== 'table') throw new Error('expected table');
    expect(block.rows[2]![2]).toEqual({ type: 'raw_text', text: 'no link here' });
  });

  it('carries per-column alignment in column_settings', () => {
    const block = renderIntentToBlocks(table)[0]!;
    if (block.type !== 'table') throw new Error('expected table');
    expect(block.column_settings).toEqual([
      { align: 'left' },
      { align: 'left' },
      { align: 'left' },
    ]);
  });

  it('prepends a markdown block when a caption is set', () => {
    const blocks = renderIntentToBlocks({ ...table, caption: 'Found 2 messages' });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'markdown', text: 'Found 2 messages' });
    expect(blocks[1]!.type).toBe('table');
  });

  it('clamps to Slack limits (100 rows incl. header, 20 cols)', () => {
    const big: TableRenderIntent = {
      kind: 'table',
      columns: Array.from({ length: 25 }, (_v, i) => ({ header: `c${i}` })),
      rows: Array.from({ length: 200 }, () =>
        Array.from({ length: 25 }, (_v, i) => ({ text: `${i}` })),
      ),
    };
    const block = renderIntentToBlocks(big)[0]!;
    if (block.type !== 'table') throw new Error('expected table');
    expect(block.rows).toHaveLength(100); // header + 99 data rows
    expect(block.rows[0]).toHaveLength(20); // columns clamped
  });
});

describe('renderIntentToFallbackText (table)', () => {
  it('produces a bulleted line per row with link URLs inlined', () => {
    expect(renderIntentToFallbackText(table)).toBe(
      '• Amit — #launch — GA is Thursday (https://x/1)\n• Priya — #eng — no link here',
    );
  });

  it('includes the caption as the first line', () => {
    const text = renderIntentToFallbackText({ ...table, caption: 'Found 2 messages' });
    expect(text.split('\n')[0]).toBe('Found 2 messages');
  });
});
