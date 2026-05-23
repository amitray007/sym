/**
 * In-process pub/sub broadcaster — taps every successful `append()` call so
 * the Dashboard activity feed (S3) can stream live events over SSE.
 *
 * Design: single-process, synchronous fan-out.  No buffering, no persistence.
 * Listeners that throw are silently removed to prevent one bad subscriber from
 * breaking the chain.
 *
 * The HTTP SSE endpoint itself lives in S3 (Dashboard).  This module provides
 * only the in-process API: `subscribe`, `unsubscribe`, and the internal
 * `emit` function called by `append`.
 */

import type { AuditEvent } from '@sym/contracts';

export type AuditEventListener = (event: AuditEvent) => void;

const listeners = new Set<AuditEventListener>();

/**
 * Register a listener that will be called after each successful `append()`.
 * Returns an unsubscribe function for convenience.
 */
export function subscribe(cb: AuditEventListener): () => void {
  listeners.add(cb);
  return () => {
    unsubscribe(cb);
  };
}

/** Remove a previously registered listener. No-op if not registered. */
export function unsubscribe(cb: AuditEventListener): void {
  listeners.delete(cb);
}

/**
 * Fan-out to all current listeners.  Called internally by `append()` — not
 * part of the public API surface (callers must not call this directly).
 *
 * Listeners that throw have their exception caught and are automatically
 * unregistered so they cannot block the fan-out for remaining subscribers.
 */
export function emit(event: AuditEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      listeners.delete(listener);
    }
  }
}

/** Return the current subscriber count.  Useful for testing. */
export function subscriberCount(): number {
  return listeners.size;
}
