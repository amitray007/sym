/**
 * Custom-relational consent management.
 *
 * When User A tells Sym a fact about User B (custom_relational scope),
 * the memory is written with `subject_consent_status = 'pending'`.  The row is
 * INVISIBLE to retrieval until the subject (User B) accepts.
 *
 * This module provides:
 *   - `requestConsent` — write a pending custom_relational memory row.
 *   - `acceptConsent`  — subject accepts; row becomes retrievable.
 *   - `rejectConsent`  — subject rejects; row stays invisible (rejected).
 *   - `pendingForSubject` — list pending rows awaiting a subject's response.
 *
 * All mutations audit via `@sym/audit`.
 *
 * The retrieval gate in `gate.ts` enforces that `subject_consent_status !=
 * 'accepted'` rows are never returned — this module is only the write/update
 * path, not an additional gate.
 */

import { append } from '@sym/audit';
import { memoryEntries, uuidv7 } from '@sym/db';
import { and, eq } from 'drizzle-orm';

import { rowToEntry } from './row-to-entry.js';

import type { MemoryEntry, SlackUserId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

export interface RequestConsentInput {
  workspaceId: WorkspaceId;
  /** The user who told Sym the fact about the subject. */
  actorId: SlackUserId;
  /** The user the fact is about — must accept for it to be retrievable. */
  subjectId: SlackUserId;
  content: string;
}

/**
 * Write a new `custom_relational` memory row with `pending` consent.
 * The row is invisible to retrieval until `acceptConsent` is called.
 */
export async function requestConsent(
  db: Database,
  input: RequestConsentInput,
): Promise<MemoryEntry> {
  const id = uuidv7();
  const scopeKey = `${input.actorId}:${input.subjectId}`;

  await db.insert(memoryEntries).values({
    id,
    workspaceId: input.workspaceId,
    scope: 'custom_relational',
    scopeKey,
    actorId: input.actorId,
    subjectId: input.subjectId,
    content: input.content,
    status: 'active',
    supersedesId: null,
    subjectConsentStatus: 'pending',
  });

  await append(db, {
    workspaceId: input.workspaceId,
    kind: 'app.memory.write',
    actorKind: 'slack_user',
    actorId: input.actorId,
    targetKind: 'memory',
    targetId: id,
    payload: {
      action: 'consent_requested',
      scope: 'custom_relational',
      scopeKey,
      subjectId: input.subjectId,
      content: input.content,
    },
  });

  return fetchConsentEntry(db, id);
}

/**
 * Subject accepts a pending memory row. Makes it visible to retrieval.
 *
 * @param db          - Drizzle database handle.
 * @param workspaceId - Workspace scope.
 * @param memoryId    - The `memory_entries.id` of the pending row.
 * @param subjectId   - Must match `memory_entries.subject_id` (verified).
 */
export async function acceptConsent(
  db: Database,
  workspaceId: WorkspaceId,
  memoryId: string,
  subjectId: SlackUserId,
): Promise<MemoryEntry> {
  const [existing] = await db
    .select()
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.id, memoryId),
        eq(memoryEntries.workspaceId, workspaceId),
        eq(memoryEntries.subjectId, subjectId),
        eq(memoryEntries.subjectConsentStatus, 'pending'),
      ),
    );

  if (!existing) {
    throw new Error(
      `consent: no pending memory id=${memoryId} for subject=${subjectId} in workspace=${workspaceId}`,
    );
  }

  await db
    .update(memoryEntries)
    .set({ subjectConsentStatus: 'accepted', updatedAt: new Date() })
    .where(eq(memoryEntries.id, memoryId));

  await append(db, {
    workspaceId,
    kind: 'app.memory.write',
    actorKind: 'slack_user',
    actorId: subjectId,
    targetKind: 'memory',
    targetId: memoryId,
    payload: {
      action: 'consent_accepted',
      scope: 'custom_relational',
      scopeKey: existing.scopeKey,
      subjectId,
    },
  });

  return fetchConsentEntry(db, memoryId);
}

/**
 * Subject rejects a pending memory row. Row status stays `active` but
 * `subject_consent_status` becomes `rejected` — invisible to retrieval forever.
 *
 * @param db          - Drizzle database handle.
 * @param workspaceId - Workspace scope.
 * @param memoryId    - The `memory_entries.id` of the pending row.
 * @param subjectId   - Must match `memory_entries.subject_id` (verified).
 */
export async function rejectConsent(
  db: Database,
  workspaceId: WorkspaceId,
  memoryId: string,
  subjectId: SlackUserId,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.id, memoryId),
        eq(memoryEntries.workspaceId, workspaceId),
        eq(memoryEntries.subjectId, subjectId),
        eq(memoryEntries.subjectConsentStatus, 'pending'),
      ),
    );

  if (!existing) {
    throw new Error(
      `consent: no pending memory id=${memoryId} for subject=${subjectId} in workspace=${workspaceId}`,
    );
  }

  await db
    .update(memoryEntries)
    .set({ subjectConsentStatus: 'rejected', updatedAt: new Date() })
    .where(eq(memoryEntries.id, memoryId));

  await append(db, {
    workspaceId,
    kind: 'app.memory.write',
    actorKind: 'slack_user',
    actorId: subjectId,
    targetKind: 'memory',
    targetId: memoryId,
    payload: {
      action: 'consent_rejected',
      scope: 'custom_relational',
      scopeKey: existing.scopeKey,
      subjectId,
    },
  });
}

/**
 * List all `pending` custom_relational memory entries awaiting a subject's
 * response. Used to display a consent-request UI to the subject.
 */
export async function pendingForSubject(
  db: Database,
  workspaceId: WorkspaceId,
  subjectId: SlackUserId,
): Promise<MemoryEntry[]> {
  const rows = await db
    .select()
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.workspaceId, workspaceId),
        eq(memoryEntries.scope, 'custom_relational'),
        eq(memoryEntries.subjectId, subjectId),
        eq(memoryEntries.subjectConsentStatus, 'pending'),
      ),
    );

  return rows.map(rowToEntry);
}

async function fetchConsentEntry(db: Database, id: string): Promise<MemoryEntry> {
  const [row] = await db.select().from(memoryEntries).where(eq(memoryEntries.id, id));
  if (!row) {
    throw new Error(`consent: could not re-fetch entry id=${id}`);
  }
  return rowToEntry(row);
}
