import { describe, expectTypeOf, it } from 'vitest';

import type { AuditEvent } from './audit.js';
import type { Receipt, Reply } from './domain.js';
import type { Result, SymError } from './errors.js';
import type { AuditEventId, SlackUserId, WorkspaceId } from './ids.js';
import type { CompletionChunk, ProviderInterface } from './provider.js';
import type { ToolResult } from './tools.js';

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
    expectTypeOf<AuditEventId>().toMatchTypeOf<number>();
  });

  it('ToolResult is a discriminated union on ok', () => {
    expectTypeOf<ToolResult>().toHaveProperty('ok');
    const r = { ok: true, callId: 'x', content: 'done' } satisfies ToolResult;
    expectTypeOf(r).toMatchTypeOf<ToolResult>();
  });

  it('ProviderInterface.complete streams CompletionChunk', () => {
    expectTypeOf<ProviderInterface['complete']>().returns.toEqualTypeOf<
      AsyncIterable<CompletionChunk>
    >();
  });

  it('Reply carries a Receipt and AuditEvent uses a branded id', () => {
    expectTypeOf<Reply>().toHaveProperty('receipt').toEqualTypeOf<Receipt>();
    expectTypeOf<AuditEvent>().toHaveProperty('id').toEqualTypeOf<AuditEventId>();
  });

  it('Result narrows on ok', () => {
    expectTypeOf<Result<number>>().toEqualTypeOf<
      { ok: true; value: number } | { ok: false; error: SymError }
    >();
  });
});
