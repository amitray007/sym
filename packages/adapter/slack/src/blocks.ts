// ---------------------------------------------------------------------------
// Slack Block Kit typed builders
// ---------------------------------------------------------------------------
// Callers must use these builders instead of constructing raw Block Kit JSON.
// This ensures type-safety and consistency with the outbound contract spec.
// ---------------------------------------------------------------------------

// --- Element types ----------------------------------------------------------

export interface MrkdwnElement {
  type: 'mrkdwn';
  text: string;
}

export interface PlainTextElement {
  type: 'plain_text';
  text: string;
  emoji: boolean;
}

export type ContextElement = MrkdwnElement | PlainTextElement;

// --- Block types ------------------------------------------------------------

export interface MarkdownBlock {
  type: 'markdown';
  text: string;
}

export interface SectionBlock {
  type: 'section';
  /** Optional when `fields` is provided (Slack requires text OR fields). */
  text?: MrkdwnElement;
  fields?: MrkdwnElement[];
}

export interface HeaderBlock {
  type: 'header';
  text: PlainTextElement;
}

export interface ContextBlock {
  type: 'context';
  elements: ContextElement[];
}

export interface DividerBlock {
  type: 'divider';
}

export interface ActionsBlock {
  type: 'actions';
  elements: unknown[];
}

// --- Table block (Block Kit; usable in messages — verified 2026-05-29) -------

/** A `raw_text` table cell — plain, unformatted text. */
export interface RawTextCell {
  type: 'raw_text';
  text: string;
}

/** A `rich_text` table cell carrying a single hyperlink (the only rich form we emit). */
export interface RichTextLinkCell {
  type: 'rich_text';
  elements: [
    {
      type: 'rich_text_section';
      elements: [{ type: 'link'; url: string; text: string }];
    },
  ];
}

export type TableCell = RawTextCell | RichTextLinkCell;

export interface TableColumnSetting {
  align?: 'left' | 'center' | 'right';
  is_wrapped?: boolean;
}

export interface TableBlock {
  type: 'table';
  /** First row is the header row. Max 100 rows, 20 cells/row (Slack limits). */
  rows: TableCell[][];
  column_settings?: TableColumnSetting[];
}

export type SlackBlock =
  | MarkdownBlock
  | SectionBlock
  | HeaderBlock
  | ContextBlock
  | DividerBlock
  | ActionsBlock
  | TableBlock;

// --- Element builders -------------------------------------------------------

/** A Slack `mrkdwn` element (used inside context, section fields, etc.). */
export function mrkdwnElement(text: string): MrkdwnElement {
  return { type: 'mrkdwn', text };
}

/** A Slack `plain_text` element. */
export function plainTextElement(text: string, emoji = true): PlainTextElement {
  return { type: 'plain_text', text, emoji };
}

// --- Block builders ---------------------------------------------------------

/**
 * A Slack `markdown` block (Block Kit v2).
 * This is the primary reply body block per the outbound contract spec.
 * Raw markdown is passed directly; Slack renders it natively.
 */
export function markdownBlock(text: string): MarkdownBlock {
  return { type: 'markdown', text };
}

/** Slack `markdown` block text limit (~12k); leave headroom. */
export const MAX_MARKDOWN_BLOCK_CHARS = 11_800;
/** Whole-message budget — keep the reply comfortably under Slack's message size + text limits. */
export const MAX_BODY_CHARS = 38_000;

/**
 * Split text into ≤`max`-char pieces, preferring a paragraph break, then a line
 * break, then a space within the window so chunks don't slice mid-word.
 */
export function splitForBlocks(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Render a reply body as one OR MORE `markdown` blocks, chunked under Slack's
 * per-block limit so a long answer (e.g. dumping `sym tools`) never trips
 * `msg_too_long`. Caps total length to `MAX_BODY_CHARS` (so the whole message
 * stays valid) and marks any truncation rather than dropping it silently.
 */
export function markdownBlocks(text: string): MarkdownBlock[] {
  if (text.length <= MAX_MARKDOWN_BLOCK_CHARS) return [{ type: 'markdown', text }];
  let body = text;
  let dropped = 0;
  if (body.length > MAX_BODY_CHARS) {
    dropped = body.length - MAX_BODY_CHARS;
    body = body.slice(0, MAX_BODY_CHARS);
  }
  const chunks = splitForBlocks(body, MAX_MARKDOWN_BLOCK_CHARS);
  if (dropped > 0) chunks.push(`…\n\n_(truncated ${dropped.toLocaleString()} more characters)_`);
  return chunks.map((t) => ({ type: 'markdown', text: t }));
}

/** A `section` block with a mrkdwn body text and optional field elements. */
export function sectionBlock(text: string, fields?: MrkdwnElement[]): SectionBlock {
  const block: SectionBlock = { type: 'section', text: mrkdwnElement(text) };
  if (fields !== undefined) {
    block.fields = fields;
  }
  return block;
}

/** A `header` block with plain text. */
export function headerBlock(text: string): HeaderBlock {
  return { type: 'header', text: plainTextElement(text, true) };
}

/** A `section` block carrying only a 2-column field grid (no body text). */
export function fieldsSection(fields: MrkdwnElement[]): SectionBlock {
  return { type: 'section', fields };
}

/** Slack hard limit on button text. Exceeding it rejects the whole message. */
const BUTTON_TEXT_MAX = 75;

/** A URL `button` element — opens a link, no interactivity callback required. */
export function urlButton(
  label: string,
  url: string,
): {
  type: 'button';
  text: PlainTextElement;
  url: string;
} {
  // Clamp to Slack's 75-char button limit — an over-long label would otherwise
  // reject the entire message, not just the button.
  const text = label.length > BUTTON_TEXT_MAX ? `${label.slice(0, BUTTON_TEXT_MAX - 1)}…` : label;
  return { type: 'button', text: plainTextElement(text, true), url };
}

/** A `context` block. Elements can be mrkdwn or plain_text elements. */
export function contextBlock(elements: ContextElement[]): ContextBlock {
  return { type: 'context', elements };
}

/** A `divider` block. */
export function dividerBlock(): DividerBlock {
  return { type: 'divider' };
}

/** An `actions` block. Elements are typed as `unknown` to allow any action element shape. */
export function actionsBlock(elements: unknown[]): ActionsBlock {
  return { type: 'actions', elements };
}

/** A `raw_text` table cell. */
export function rawTextCell(text: string): RawTextCell {
  return { type: 'raw_text', text };
}

/**
 * A `rich_text` table cell that renders `text` as a link to `url`.
 *
 * Slack rejects a `link` element with EMPTY text (`invalid_arguments`), which
 * happens for search results whose message has no top-level text (e.g. bot/app
 * alerts whose content is in attachments). Fall back to the URL as the label so
 * the cell is always valid.
 */
export function linkCell(text: string, url: string): RichTextLinkCell {
  const label = text.trim().length > 0 ? text : url;
  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url, text: label }] }],
  };
}

/** A `table` block. First row should be the header row. */
export function tableBlock(rows: TableCell[][], columnSettings?: TableColumnSetting[]): TableBlock {
  const block: TableBlock = { type: 'table', rows };
  if (columnSettings !== undefined) {
    block.column_settings = columnSettings;
  }
  return block;
}
