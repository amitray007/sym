// ---------------------------------------------------------------------------
// In-memory action-token store
//
// Slack issues a per-event `action_token` on every message delivered to an
// agent app. That token is required when calling AI-native APIs like
// `assistant.search.context` with a bot token. We capture the latest token
// per `(channelId, threadTs)` so the next tool dispatch can use the freshest
// one available for the current thread.
//
// Same bounded-Map pattern as `assistant-context.ts`.
// ---------------------------------------------------------------------------

export interface ActionTokenStore {
  /** Record the latest action_token for an assistant/channel thread. */
  remember(channelId: string, threadTs: string, actionToken: string): void;
  /** Latest captured action_token for a thread, if any. */
  lookup(channelId: string, threadTs: string): string | undefined;
}

export function createActionTokenStore(max = 5_000): ActionTokenStore {
  const store = new Map<string, string>();

  return {
    remember(channelId: string, threadTs: string, actionToken: string): void {
      if (actionToken.length === 0) return;
      const key = `${channelId}:${threadTs}`;
      store.set(key, actionToken);
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

    lookup(channelId: string, threadTs: string): string | undefined {
      return store.get(`${channelId}:${threadTs}`);
    },
  };
}
