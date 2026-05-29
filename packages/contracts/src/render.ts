/**
 * Render intents — code-owned presentation hints a tool may attach to its
 * result. The Slack adapter turns an intent into Block Kit blocks; the model
 * NEVER authors Block Kit JSON. Two producers feed the same channel:
 *   - tool-attached (deterministic, e.g. `search_messages` → `table`)
 *   - model-decided `present_*` tools (the model picks a surface)
 *
 * Every intent MUST degrade to plain fallback text (notifications +
 * accessibility). The union grows additively as surfaces are added.
 *
 * Surfaces verified usable in a THREAD MESSAGE on 2026-05-29:
 *   - `table` → Slack `table` block (≤100 rows, ≤20 cells/row, first row = header)
 *
 * Deliberately NOT modelled yet: `card` (the `card` block's message-surface is
 * undocumented — when added it will render via `section`+fields, which IS
 * confirmed), `carousel` (unconfirmed), `alert` (modal-only).
 */

/** One column definition for a {@link TableRenderIntent}. */
export interface RenderTableColumn {
  /** Header label shown in the table's first row. */
  header: string;
  /** Alignment hint; defaults to left. */
  align?: 'left' | 'center' | 'right';
}

/** One cell. When `link` is set the cell renders as a hyperlink. */
export interface RenderTableCell {
  /** Visible text. Already mention-resolved by the producing tool. */
  text: string;
  /** When present, the cell renders as a link to this URL. */
  link?: string;
}

/**
 * A tabular result — the answer is a set of rows over fixed columns. Rendered
 * as a Slack `table` block; falls back to a plain bulleted list.
 */
export interface TableRenderIntent {
  kind: 'table';
  /** Optional one-line lead rendered above the table. */
  caption?: string;
  columns: RenderTableColumn[];
  /** Rows aligned to `columns`; cells beyond the column count are ignored. */
  rows: RenderTableCell[][];
}

/** One `label: value` pair shown in a {@link CardRenderIntent}'s field grid. */
export interface CardField {
  label: string;
  value: string;
}

/** A link button on a card. URL-only — no interactivity infra (no 3s-ack listener). */
export interface CardAction {
  label: string;
  url: string;
}

/**
 * A single record the owner will act on (incident, PR, person, channel, config).
 * Rendered as a header + body + 2-col field grid + optional link buttons, built
 * from confirmed `section`/`header`/`actions` blocks. (Slack's `card` block is
 * NOT used — its message-surface support is undocumented.) Falls back to a
 * title + bulleted label/value lines.
 */
export interface CardRenderIntent {
  kind: 'card';
  title: string;
  /** Short decision-critical summary line. */
  body?: string;
  fields?: CardField[];
  actions?: CardAction[];
}

/** The discriminated union of every supported render intent. */
export type RenderIntent = TableRenderIntent | CardRenderIntent;
