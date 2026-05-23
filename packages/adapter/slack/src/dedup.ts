import type { SlackEventId } from '@sym/contracts';

/**
 * A store for deduplicating Slack events by their `event_id`.
 *
 * The Redis-backed implementation is wired in `apps/agent` (later chunk).
 * Callers must inject a concrete implementation at runtime.
 *
 * Contract:
 *   - `isDuplicate` returns true if `eventId` was previously seen.
 *   - `markSeen` persists the event ID with an expiry (recommend 1 hour
 *     to cover Slack's replay window + clock drift).
 *   - If `isDuplicate` returns true, the caller must skip processing.
 *   - Calling `markSeen` without first calling `isDuplicate` is valid
 *     (idempotent inserts are expected).
 */
export interface DedupStore {
  isDuplicate(eventId: SlackEventId): Promise<boolean>;
  markSeen(eventId: SlackEventId, ttlSeconds?: number): Promise<void>;
}

/**
 * Extracts the dedup key from a normalised `SlackTurnInput`'s eventId.
 * Exposed so callers do not need to know the internal key format.
 */
export function extractDedupKey(eventId: SlackEventId): string {
  return `slack:event:${eventId}`;
}
