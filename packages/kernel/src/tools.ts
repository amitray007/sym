import type { ToolDispatcher } from '@sym/contracts';

/**
 * Tool registry wrapper. In v1 with no tools wired (pre-S5), the registry
 * is empty and `list()` returns `[]`. The kernel passes this list to the
 * provider's `CompletionRequest.tools`. An empty list means the provider
 * sends no tool schemas — the model will not emit tool calls.
 *
 * Fail-closed: if the model somehow emits a tool call and no dispatcher is
 * present, the kernel logs a warning and skips the call rather than crashing.
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
