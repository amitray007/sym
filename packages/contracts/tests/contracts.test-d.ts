import { describe, expectTypeOf, it } from 'vitest';

import type { Receipt, Reply } from '../src/domain.js';
import type { Result, SymError } from '../src/errors.js';
import type { SlackUserId, WorkspaceId } from '../src/ids.js';
import type { CompletionChunk, ProviderInterface } from '../src/provider.js';
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

  it('ProviderInterface.complete streams CompletionChunk', () => {
    expectTypeOf<ProviderInterface['complete']>().returns.toEqualTypeOf<
      AsyncIterable<CompletionChunk>
    >();
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
