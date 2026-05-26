import type { ToolDispatcher } from '@sym/contracts';

/**
 * Tool registry wrapper. Wraps a `ToolDispatcher` and exposes its tool list
 * to the Pi loop.
 *
 * Fail-closed: if no dispatcher is present, `listTools()` returns `[]` and
 * `getDispatcher()` returns null — the caller handles the absence explicitly.
 */
export class ToolRegistry {
  private readonly dispatcher: ToolDispatcher | null;

  constructor(dispatcher: ToolDispatcher | null = null) {
    this.dispatcher = dispatcher;
  }

  /** Return tool descriptors from the dispatcher, or empty if no dispatcher. */
  listTools(): ReturnType<ToolDispatcher['list']> {
    return this.dispatcher?.list() ?? [];
  }

  /** Whether any tools are registered. */
  hasTools(): boolean {
    return this.listTools().length > 0;
  }

  /** Access the underlying dispatcher (null if none registered). */
  getDispatcher(): ToolDispatcher | null {
    return this.dispatcher;
  }
}
