/**
 * Built-in tools: present_card, present_table.
 *
 * Presentation tools that attach a code-owned `RenderIntent` to a tool result,
 * signalling the Slack adapter to render a structured card or table instead of
 * plain text. No Slack API calls, no auth. Pure arg-validation + render assembly.
 */

import { argError, coerceCardActions, coerceCardFields } from './_helpers.js';

import type {
  JsonSchema,
  RenderIntent,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from '@sym/contracts';

export const PRESENT_CARD_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'present_card',
  description: [
    'Present the answer as a CARD when the answer IS one record the owner will act on — an incident, a PR, a person, a channel, a config item. Renders a title, a one-line summary, a small label/value grid (status, owner, priority, updated, …), and optional link buttons.',
    '',
    'Use ONLY for a single structured record. Do NOT use it for a plain prose answer, a one-liner, or a list (for a list to compare, use present_table; search results already render as a table automatically).',
    '',
    'After calling, write only a ONE-LINE lead in your reply — do NOT restate the title or fields in prose; the owner already sees the card.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Card title — the record name, e.g. "INC-204 · API latency".',
      },
      body: { type: 'string', description: 'Optional one-line decision-critical summary.' },
      fields: {
        type: 'array',
        description: 'Up to 10 label/value pairs (status, owner, priority, updated, …).',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, value: { type: 'string' } },
          required: ['label', 'value'],
          additionalProperties: false,
        },
      },
      actions: {
        type: 'array',
        description: 'Optional link buttons (label + https url). Links only — no in-Slack actions.',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, url: { type: 'string' } },
          required: ['label', 'url'],
          additionalProperties: false,
        },
      },
    },
    required: ['title'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

export const PRESENT_TABLE_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'present_table',
  description: [
    'Present the answer as a TABLE when it is a small set of rows the owner will compare or scan that YOU synthesized — a comparison (A vs B vs C), a shortlist, a breakdown. `columns` are headers; each row is an array of cell strings aligned to the columns.',
    '',
    'Use ONLY when a table reads better than prose. Do NOT use it for a single record (use present_card), a one-line answer, or for search results (those auto-render as a table).',
    '',
    'After calling, write only a ONE-LINE lead — do NOT restate the rows in prose.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      caption: { type: 'string', description: 'Optional one-line lead shown above the table.' },
      columns: {
        type: 'array',
        description: 'Column headers, left to right (max 20).',
        items: { type: 'string' },
      },
      rows: {
        type: 'array',
        description: 'Rows; each row is an array of cell strings aligned to columns.',
        items: { type: 'array', items: { type: 'string' } },
      },
    },
    required: ['columns', 'rows'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

export function handlePresentCard(call: ToolCall): ToolResult {
  // Presentation tool — no Slack client. Validates args, attaches a `card`
  // render that the adapter turns into header+fields+buttons. The model
  // still writes the one-line lead; `content` nudges it not to duplicate.
  const titleArg = call.arguments['title'];
  if (typeof titleArg !== 'string' || titleArg.trim().length === 0) {
    return argError(call, 'title must be a non-empty string');
  }
  const bodyArg = call.arguments['body'];
  const fields = coerceCardFields(call.arguments['fields']);
  const actions = coerceCardActions(call.arguments['actions']);
  const render: RenderIntent = {
    kind: 'card',
    title: titleArg,
    ...(typeof bodyArg === 'string' && bodyArg.length > 0 ? { body: bodyArg } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
  return {
    callId: call.id,
    ok: true,
    content: 'Card shown to the owner. Write only a one-line lead; do not restate the fields.',
    render,
  };
}

export function handlePresentTable(call: ToolCall): ToolResult {
  const columnsArg = call.arguments['columns'];
  const rowsArg = call.arguments['rows'];
  if (
    !Array.isArray(columnsArg) ||
    columnsArg.length === 0 ||
    columnsArg.some((c) => typeof c !== 'string')
  ) {
    return argError(call, 'columns must be a non-empty array of strings');
  }
  if (
    !Array.isArray(rowsArg) ||
    !rowsArg.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'))
  ) {
    return argError(call, 'rows must be an array of arrays of strings');
  }
  const captionArg = call.arguments['caption'];
  const render: RenderIntent = {
    kind: 'table',
    ...(typeof captionArg === 'string' && captionArg.length > 0 ? { caption: captionArg } : {}),
    columns: (columnsArg as string[]).map((header) => ({ header })),
    rows: (rowsArg as string[][]).map((r) => r.map((text) => ({ text }))),
  };
  return {
    callId: call.id,
    ok: true,
    content: 'Table shown to the owner. Write only a one-line lead; do not restate the rows.',
    render,
  };
}
