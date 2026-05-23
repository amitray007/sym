/**
 * MCP Auth Store — in-memory implementation of the challenge-driven OAuth
 * session store described in oauth-flows-spec.md §"MCP auth sessions".
 *
 * Key pattern: `mcp_auth:<state>` (random hex, TTL 10 minutes by default).
 *
 * NOTE: Production deployments should swap this for a Redis-backed
 * implementation once the Redis client is wired (see the module comment in
 * oauth-flows-spec.md §"MCP auth sessions and credentials").
 * The interface is injectable so the swap requires no changes to callers.
 *
 * REDIS TODO: Implement `RedisMcpAuthStore` in a future stream (S8 or a
 * dedicated redis stream) that uses `SET key value EX <ttl> NX` for atomic
 * writes and `GET`/`DEL` for read/consume.
 */

import type { McpAuthSession, McpAuthStore } from './types.js';

const DEFAULT_TTL_MS = 10 * 60 * 1_000; // 10 minutes

interface StoredSession {
  session: McpAuthSession;
  expiresAt: number;
}

/**
 * In-memory MCP auth session store.
 *
 * Thread-safe for single-process Node.js (event loop).
 * Not suitable for multi-replica deployments without Redis.
 */
export class InMemoryMcpAuthStore implements McpAuthStore {
  private readonly sessions = new Map<string, StoredSession>();

  async set(state: string, session: McpAuthSession, ttlMs = DEFAULT_TTL_MS): Promise<void> {
    this.sessions.set(state, {
      session,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async get(state: string): Promise<McpAuthSession | undefined> {
    const entry = this.sessions.get(state);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(state);
      return undefined;
    }
    return entry.session;
  }

  async delete(state: string): Promise<void> {
    this.sessions.delete(state);
  }

  /** Evict all expired sessions. Call periodically to prevent memory growth. */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now > entry.expiresAt) {
        this.sessions.delete(key);
      }
    }
  }
}
