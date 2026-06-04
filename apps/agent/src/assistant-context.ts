/**
 * In-memory viewed-channel context store.
 *
 * Tracks the Slack channel a user is currently viewing for each assistant
 * panel thread. Updated by `assistant_thread_started` and
 * `assistant_thread_context_changed` lifecycle events; read by `handleTurn`
 * to provide background context to the model.
 */

export interface AssistantContextStore {
  /** Record the channel the user is viewing for an assistant thread (clears when undefined). */
  remember(
    assistantChannelId: string,
    threadTs: string,
    contextChannelId: string | undefined,
  ): void;
  /** The channel the user is viewing for an assistant thread, if known. */
  lookup(assistantChannelId: string, threadTs: string): string | undefined;
}

/**
 * Create a bounded in-memory store for viewed-channel context keyed by
 * `${assistantChannelId}:${threadTs}`.
 *
 * When the store exceeds `max` entries, the oldest half (insertion order) is
 * dropped — same bounding strategy as `createDedup` in server.ts.
 *
 * `remember(..., undefined)` deletes the key (the user is no longer viewing
 * any channel, or the context was cleared).
 */
export function createAssistantContextStore(max = 5_000): AssistantContextStore {
  const store = new Map<string, string>();

  return {
    remember(
      assistantChannelId: string,
      threadTs: string,
      contextChannelId: string | undefined,
    ): void {
      const key = `${assistantChannelId}:${threadTs}`;
      if (contextChannelId === undefined) {
        store.delete(key);
        return;
      }
      store.set(key, contextChannelId);
      if (store.size > max) {
        // Drop the oldest half (Map preserves insertion order).
        const half = Math.floor(max / 2);
        let i = 0;
        for (const k of store.keys()) {
          if (i >= half) break;
          store.delete(k);
          i++;
        }
      }
    },

    lookup(assistantChannelId: string, threadTs: string): string | undefined {
      return store.get(`${assistantChannelId}:${threadTs}`);
    },
  };
}
