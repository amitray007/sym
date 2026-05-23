/**
 * Helper: convert a raw DB row from `memory_entries` to the `MemoryEntry`
 * contract shape.
 *
 * With `exactOptionalPropertyTypes`, optional fields must not be assigned
 * `undefined`. We guard with non-null checks and cast to the concrete branded
 * type (e.g. `SlackUserId` rather than `MemoryEntry['subjectId']` which
 * resolves to `SlackUserId | undefined` and triggers the TS2412 error).
 */

import type { MemoryEntry, MemoryId, MemoryScope, SlackUserId } from '@sym/contracts';

/** Minimal shape of a Drizzle memory_entries row (columns we map). */
export interface MemoryRow {
  id: string;
  workspaceId: string;
  scope: string;
  scopeKey: string | null;
  actorId: string;
  subjectId: string | null;
  content: string;
  status: string;
  supersedesId: string | null;
  subjectConsentStatus: string;
  createdAt: Date;
  updatedAt: Date;
  lastReferencedAt: Date | null;
}

/** Narrow type used only to set optional properties without triggering TS2412. */
interface MutableEntry {
  scopeKey?: string;
  subjectId?: SlackUserId;
  supersedesId?: MemoryId;
  lastReferencedAt?: Date;
}

/**
 * Convert a DB row to a `MemoryEntry`.
 *
 * Optional fields are only set when the DB value is non-null.
 */
export function rowToEntry(row: MemoryRow): MemoryEntry {
  // Build the required fields first.
  const required: Omit<
    MemoryEntry,
    'scopeKey' | 'subjectId' | 'supersedesId' | 'lastReferencedAt'
  > = {
    id: row.id as MemoryEntry['id'],
    workspaceId: row.workspaceId as MemoryEntry['workspaceId'],
    scope: row.scope as MemoryScope,
    actorId: row.actorId as MemoryEntry['actorId'],
    content: row.content,
    status: row.status as MemoryEntry['status'],
    subjectConsentStatus: row.subjectConsentStatus as MemoryEntry['subjectConsentStatus'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  // Build optional fields separately and merge — avoids TS2412 because we
  // never set an optional field to `undefined`.
  const optional: MutableEntry = {};
  if (row.scopeKey !== null) optional.scopeKey = row.scopeKey;
  if (row.subjectId !== null) optional.subjectId = row.subjectId as SlackUserId;
  if (row.supersedesId !== null) optional.supersedesId = row.supersedesId as MemoryId;
  if (row.lastReferencedAt !== null) optional.lastReferencedAt = row.lastReferencedAt;

  return { ...required, ...optional };
}
