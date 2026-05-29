/**
 * Render intents → Slack Block Kit. The ONLY place a RenderIntent becomes
 * blocks. Tools (and model-decided `present_*` tools) emit intents; this module
 * owns the block JSON so the model never authors it.
 *
 * Every intent also produces plain fallback text — used as the message's
 * top-level `text` for notifications and screen readers (Slack reads the
 * top-level text, not interior block content).
 */

import {
  actionsBlock,
  fieldsSection,
  headerBlock,
  linkCell,
  markdownBlock,
  mrkdwnElement,
  rawTextCell,
  sectionBlock,
  tableBlock,
  urlButton,
} from './blocks.js';

import type { MrkdwnElement, SlackBlock, TableCell, TableColumnSetting } from './blocks.js';
import type { CardRenderIntent, RenderIntent, TableRenderIntent } from '@sym/contracts';

/** Slack `header` block plain-text limit. */
const MAX_HEADER_CHARS = 150;

/** Slack hard limits on the `table` block. */
const MAX_TABLE_ROWS = 100; // includes the header row
const MAX_TABLE_COLS = 20;

/** Render an intent to the blocks that sit beneath the markdown reply body. */
export function renderIntentToBlocks(intent: RenderIntent): SlackBlock[] {
  switch (intent.kind) {
    case 'table':
      return tableIntentToBlocks(intent);
    case 'card':
      return cardIntentToBlocks(intent);
    default: {
      // Exhaustiveness guard — adding a RenderIntent variant without a renderer
      // is a compile error here.
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

/** Plain-text fallback for an intent (notifications + accessibility). */
export function renderIntentToFallbackText(intent: RenderIntent): string {
  switch (intent.kind) {
    case 'table':
      return tableIntentToFallback(intent);
    case 'card':
      return cardIntentToFallback(intent);
    default: {
      const _exhaustive: never = intent;
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

function cardIntentToBlocks(intent: CardRenderIntent): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const title =
    intent.title.length > MAX_HEADER_CHARS
      ? `${intent.title.slice(0, MAX_HEADER_CHARS - 1)}…`
      : intent.title;
  blocks.push(headerBlock(title));

  if (intent.body !== undefined && intent.body.trim().length > 0) {
    blocks.push(sectionBlock(intent.body));
  }

  if (intent.fields !== undefined && intent.fields.length > 0) {
    // Slack renders ≤10 section fields in a 2-column grid.
    const elements: MrkdwnElement[] = intent.fields
      .slice(0, 10)
      .map((f) => mrkdwnElement(`*${f.label}*\n${f.value}`));
    blocks.push(fieldsSection(elements));
  }

  if (intent.actions !== undefined && intent.actions.length > 0) {
    // URL buttons only — no interactivity callback. Actions block holds ≤5.
    blocks.push(actionsBlock(intent.actions.slice(0, 5).map((a) => urlButton(a.label, a.url))));
  }

  return blocks;
}

function cardIntentToFallback(intent: CardRenderIntent): string {
  const lines: string[] = [intent.title];
  if (intent.body !== undefined && intent.body.trim().length > 0) {
    lines.push(intent.body);
  }
  for (const f of intent.fields ?? []) {
    lines.push(`${f.label}: ${f.value}`);
  }
  for (const a of intent.actions ?? []) {
    lines.push(`${a.label}: ${a.url}`);
  }
  return lines.join('\n');
}
