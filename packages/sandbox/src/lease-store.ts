/**
 * Lease store — hot in-memory map + Postgres-backed interface.
 *
 * The LeaseStore is the single source of truth for active leases during a turn.
 * Leases are written before sandbox spawn (by the lease issuer) and read by the
 * egress proxy on every outbound request. TTL is the turn duration.
 *
 * Architecture:
 * - Hot layer: in-memory Map keyed by `sandboxJwtId` for O(1) proxy lookup.
 * - Cold layer: Postgres `leases` table via @sym/db (written by LeaseIssuer).
 * - The proxy always hits the hot layer first; the cold layer is for durability
 *   and audit. Expired leases are pruned lazily on lookup.
 *
 * Security invariant: no token values are ever stored in the lease. Only
 * `oauthTokenId` is stored; the proxy resolves the real token via @sym/db.
 */

import type { LeaseRef, SandboxJwtId } from '@sym/contracts';

/** In-memory map of sandboxJwtId → lease. TTL enforced on read. */
export class LeaseStore {
  private readonly store = new Map<string, LeaseRef>();

  /**
   * Add a lease to the hot store. Overwrites any existing lease for the same jwtId
   * (idempotent for retries — same jti means same lease).
   */
  put(lease: LeaseRef): void {
    this.store.set(lease.sandboxJwtId as string, lease);
  }

  /**
   * Look up a lease by the sandbox JWT's `jti`.
   * Returns undefined if not found or if the lease has expired.
   * Expired leases are evicted lazily on lookup.
   */
  get(sandboxJwtId: SandboxJwtId): LeaseRef | undefined {
    const lease = this.store.get(sandboxJwtId as string);
    if (!lease) return undefined;
    if (lease.expiresAt <= new Date()) {
      this.store.delete(sandboxJwtId as string);
      return undefined;
    }
    return lease;
  }

  /**
   * Explicitly remove a lease (called on turn end or revocation).
   */
  delete(sandboxJwtId: SandboxJwtId): void {
    this.store.delete(sandboxJwtId as string);
  }

  /**
   * Evict all leases that have expired. Call periodically to prevent unbounded growth.
   */
  evictExpired(): number {
    const now = new Date();
    let evicted = 0;
    for (const [key, lease] of this.store) {
      if (lease.expiresAt <= now) {
        this.store.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  /** Current count of leases in the hot store (including potentially expired ones). */
  size(): number {
    return this.store.size;
  }
}
