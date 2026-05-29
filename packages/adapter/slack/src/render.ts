/**
 * Render intents → Slack Block Kit. The ONLY place a RenderIntent becomes
 * blocks. Tools (and model-decided `present_*` tools) emit intents; this module
 * owns the block JSON so the model never authors it.
 *
 * Every intent also produces plain fallback text — used as the message's
 * top-level `text` for notifications and screen readers (Slack reads the
 * top-level text, not interior block content).
 */

import { markdownBlock, rawTextCell, linkCell, tableBlock } from './blocks.js';

import type { SlackBlock, TableCell, TableColumnSetting } from './blocks.js';
import type { RenderIntent, TableRenderIntent } from '@sym/contracts';

/** Slack hard limits on the `table` block. */
const MAX_TABLE_ROWS = 100; // includes the header row
const MAX_TABLE_COLS = 20;

/** Render an intent to the blocks that sit beneath the markdown reply body. */
export function renderIntentToBlocks(intent: RenderIntent): SlackBlock[] {
  switch (intent.kind) {
    case 'table':
      return tableIntentToBlocks(intent);
    default: {
      // Exhaustiveness guard — adding a RenderIntent variant without a renderer
      // is a compile error here.
      const _exhaustive: never = intent.kind;
      return _exhaustive;
    }
  }
}

/** Plain-text fallback for an intent (notifications + accessibility). */
export function renderIntentToFallbackText(intent: RenderIntent): string {
  switch (intent.kind) {
    case 'table':
      return tableIntentToFallback(intent);
    default: {
      const _exhaustive: never = intent.kind;
      return _exhaustive;
    }
  }
}

function tableIntentToBlocks(intent: TableRenderIntent): SlackBlock[] {
  const columns = intent.columns.slice(0, MAX_TABLE_COLS);
  const blocks: SlackBlock[] = [];

  if (intent.caption !== undefined && intent.caption.trim().length > 0) {
    blocks.push(markdownBlock(intent.caption));
  }

  const headerRow: TableCell[] = columns.map((c) => rawTextCell(c.header));
  const dataRows: TableCell[][] = intent.rows.slice(0, MAX_TABLE_ROWS - 1).map((row) =>
    columns.map((_col, i) => {
      const cell = row[i];
      if (cell === undefined) return rawTextCell('');
      return cell.link !== undefined && cell.link.length > 0
        ? linkCell(cell.text, cell.link)
        : rawTextCell(cell.text);
    }),
  );

  const columnSettings: TableColumnSetting[] = columns.map((c) => ({
    align: c.align ?? 'left',
  }));

  blocks.push(tableBlock([headerRow, ...dataRows], columnSettings));
  return blocks;
}

function tableIntentToFallback(intent: TableRenderIntent): string {
  const lines: string[] = [];
  if (intent.caption !== undefined && intent.caption.trim().length > 0) {
    lines.push(intent.caption);
  }
  for (const row of intent.rows) {
    const parts = row.map((cell) =>
      cell.link !== undefined && cell.link.length > 0 ? `${cell.text} (${cell.link})` : cell.text,
    );
    lines.push(`• ${parts.filter((p) => p.length > 0).join(' — ')}`);
  }
  return lines.join('\n');
}
