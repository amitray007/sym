import { assertType, describe, expectTypeOf, it } from 'vitest';

import type { Receipt, Reply } from '../src/domain.js';
import type { Result, SymError } from '../src/errors.js';
import type { SlackUserId, WorkspaceId } from '../src/ids.js';
import type {
  CardAction,
  CardField,
  CardRenderIntent,
  RenderIntent,
  RenderTableCell,
  RenderTableColumn,
  TableRenderIntent,
} from '../src/render.js';
import type { ToolResult } from '../src/tools.js';

// Type-only assertions, checked by `vitest run --typecheck`. They prove the
// contract surface composes and that brands are nominal.
describe('@sym/contracts type invariants', () => {
  it('branded ids are nominal (a plain string is not a WorkspaceId)', () => {
    expectTypeOf<string>().not.toMatchTypeOf<WorkspaceId>();
    expectTypeOf<WorkspaceId>().toMatchTypeOf<string>();
    expectTypeOf<WorkspaceId>().not.toEqualTypeOf<string>();
  });

  it('distinct brands are not interchangeable', () => {
    expectTypeOf<WorkspaceId>().not.toEqualTypeOf<SlackUserId>();
  });

  it('ToolResult is a discriminated union on ok', () => {
    expectTypeOf<ToolResult>().toHaveProperty('ok');
    const r = { ok: true, callId: 'x', content: 'done' } satisfies ToolResult;
    expectTypeOf(r).toMatchTypeOf<ToolResult>();
  });

  it('Reply carries a Receipt', () => {
    expectTypeOf<Reply>().toHaveProperty('receipt').toEqualTypeOf<Receipt>();
  });

  it('Result narrows on ok', () => {
    expectTypeOf<Result<number>>().toEqualTypeOf<
      { ok: true; value: number } | { ok: false; error: SymError }
    >();
  });
});

// ---------------------------------------------------------------------------
// RenderIntent type invariants
// ---------------------------------------------------------------------------
describe('@sym/contracts RenderIntent type invariants', () => {
  it('RenderIntent is a discriminated union on kind', () => {
    expectTypeOf<RenderIntent>().toHaveProperty('kind');
    // The union has exactly two members: table and card
    expectTypeOf<RenderIntent['kind']>().toEqualTypeOf<'table' | 'card'>();
  });

  it('TableRenderIntent has kind: "table" and required columns + rows', () => {
    // A valid TableRenderIntent literal satisfies the type.
    const tableIntent = {
      kind: 'table' as const,
      columns: [{ header: 'Name' }],
      rows: [[{ text: 'Amit' }]],
    } satisfies TableRenderIntent;
    assertType<TableRenderIntent>(tableIntent);
    expectTypeOf(tableIntent.kind).toEqualTypeOf<'table'>();
    // columns and rows use toMatchTypeOf (not toEqualTypeOf) because
    // exactOptionalPropertyTypes causes toEqualTypeOf to fail on optional fields.
    expectTypeOf(tableIntent.columns).toMatchTypeOf<RenderTableColumn[]>();
    expectTypeOf(tableIntent.rows).toMatchTypeOf<RenderTableCell[][]>();
  });

  it('TableRenderIntent has optional caption', () => {
    expectTypeOf<TableRenderIntent>().toHaveProperty('caption');
    // caption is optional — undefined must be assignable
    const withCaption = {
      kind: 'table' as const,
      columns: [{ header: 'Col' }],
      rows: [],
      caption: 'My table',
    } satisfies TableRenderIntent;
    assertType<TableRenderIntent>(withCaption);
  });

  it('RenderTableColumn has required header and optional align', () => {
    const col: RenderTableColumn = { header: 'Status' };
    assertType<RenderTableColumn>(col);
    expectTypeOf(col.header).toEqualTypeOf<string>();
    // align is optional
    const colWithAlign: RenderTableColumn = { header: 'Priority', align: 'center' };
    assertType<RenderTableColumn>(colWithAlign);
    expectTypeOf<RenderTableColumn['align']>().toEqualTypeOf<
      'left' | 'center' | 'right' | undefined
    >();
  });

  it('RenderTableCell has required text and optional link', () => {
    const cell: RenderTableCell = { text: 'hello' };
    assertType<RenderTableCell>(cell);
    const linkedCell: RenderTableCell = { text: 'click me', link: 'https://example.com' };
    assertType<RenderTableCell>(linkedCell);
    expectTypeOf<RenderTableCell['link']>().toEqualTypeOf<string | undefined>();
  });

  it('CardRenderIntent has kind: "card" and required title', () => {
    const cardIntent = {
      kind: 'card' as const,
      title: 'INC-204 · API latency',
    } satisfies CardRenderIntent;
    assertType<CardRenderIntent>(cardIntent);
    expectTypeOf(cardIntent.kind).toEqualTypeOf<'card'>();
    expectTypeOf(cardIntent.title).toEqualTypeOf<string>();
  });

  it('CardRenderIntent has optional body, fields, and actions', () => {
    const fullCard = {
      kind: 'card' as const,
      title: 'Incident',
      body: 'Slow query identified',
      fields: [{ label: 'Owner', value: 'Priya' }],
      actions: [{ label: 'Open', url: 'https://slack.com/x' }],
    } satisfies CardRenderIntent;
    assertType<CardRenderIntent>(fullCard);
    expectTypeOf<CardRenderIntent['body']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CardRenderIntent['fields']>().toEqualTypeOf<CardField[] | undefined>();
    expectTypeOf<CardRenderIntent['actions']>().toEqualTypeOf<CardAction[] | undefined>();
  });

  it('CardField has required label and value (both strings)', () => {
    const field: CardField = { label: 'Status', value: 'Open' };
    assertType<CardField>(field);
    expectTypeOf(field.label).toEqualTypeOf<string>();
    expectTypeOf(field.value).toEqualTypeOf<string>();
  });

  it('CardAction has required label and url (both strings)', () => {
    const action: CardAction = { label: 'Open in GitHub', url: 'https://github.com' };
    assertType<CardAction>(action);
    expectTypeOf(action.label).toEqualTypeOf<string>();
    expectTypeOf(action.url).toEqualTypeOf<string>();
  });

  it('TableRenderIntent is a member of the RenderIntent union', () => {
    expectTypeOf<TableRenderIntent>().toMatchTypeOf<RenderIntent>();
  });

  it('CardRenderIntent is a member of the RenderIntent union', () => {
    expectTypeOf<CardRenderIntent>().toMatchTypeOf<RenderIntent>();
  });

  it('a plain object with only kind:"table" does NOT satisfy RenderIntent (columns+rows required)', () => {
    // This must be a compile-time check: the type without columns/rows should not match.
    interface MissingRequired {
      kind: 'table';
    }
    expectTypeOf<MissingRequired>().not.toMatchTypeOf<TableRenderIntent>();
  });
});
