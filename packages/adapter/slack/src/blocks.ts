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
  text: MrkdwnElement;
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

export type SlackBlock =
  | MarkdownBlock
  | SectionBlock
  | HeaderBlock
  | ContextBlock
  | DividerBlock
  | ActionsBlock;

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
