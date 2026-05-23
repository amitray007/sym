/**
 * Memory writer — applies a `ClassifyResult` to the database.
 *
 * Decision → DB action:
 *   add       → INSERT new active row
 *   update    → UPDATE content of existing row (audit trail preserved via audit)
 *   supersede → mark old row `superseded`, INSERT new row referencing old via
 *               `supersedes_id`
 *   ignore    → no-op; returns null
 *
 * Every mutation calls `@sym/audit`'s `append` with an `app.memory.*` kind.
 * The audit call is the ONLY sanctioned write to `audit_events`.
 */

import { append } from '@sym/audit';
import { memoryEntries, uuidv7 } from '@sym/db';
import { eq } from 'drizzle-orm';

import { rowToEntry } from './row-to-entry.js';

import type { ClassifyResult } from './classifier.js';
import type {
  MemoryEntry,
  MemoryScope,
  SlackUserId,
  SubjectConsentStatus,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';

/** Input for writing a memory entry. */
export interface WriteInput {
  workspaceId: WorkspaceId;
  scope: MemoryScope;
  /** Scope key per schema conventions. See memory_entries.scope_key. */
  scopeKey?: string;
  actorId: SlackUserId;
  subjectId?: SlackUserId;
  content: string;
  /**
   * For `custom_relational` scope: the consent status to store.
   * Must be `'not_applicable'` for all other scopes.
   * Defaults to `'not_applicable'`.
   */
  subjectConsentStatus?: SubjectConsentStatus;
}

/** Result of applying a write. */
export type WriteResult =
  | { kind: 'inserted'; entry: MemoryEntry }
  | { kind: 'updated'; entry: MemoryEntry }
  | { kind: 'superseded'; oldId: string; entry: MemoryEntry }
  | { kind: 'ignored' };

/**
 * Apply a classifier result to the database.
 *
 * @param db      - Drizzle database handle.
 * @param input   - The memory content and scope metadata to write.
 * @param result  - The classifier output. `result.existingId` must be set for
 *                  `update` and `supersede` decisions.
 * @returns       - The write result, or `{ kind: 'ignored' }` for no-ops.
 */
export async function applyDecision(
  db: Database,
  input: WriteInput,
  result: ClassifyResult,
): Promise<WriteResult> {
  const { decision } = result;

  if (decision === 'ignore') {
    return { kind: 'ignored' };
  }

  const subjectConsentStatus = input.subjectConsentStatus ?? 'not_applicable';

  if (decision === 'add') {
    const id = uuidv7();

    // Insert the new memory row.
    await db.insert(memoryEntries).values({
      id,
      workspaceId: input.workspaceId,
      scope: input.scope,
      scopeKey: input.scopeKey ?? null,
      actorId: input.actorId,
      subjectId: input.subjectId ?? null,
      content: input.content,
      status: 'active',
      supersedesId: null,
      subjectConsentStatus,
    });

    // Audit the write.
    await append(db, {
      workspaceId: input.workspaceId,
      kind: 'app.memory.write',
      actorKind: 'slack_user',
      actorId: input.actorId,
      targetKind: 'memory',
      targetId: id,
      payload: {
        action: 'add',
        scope: input.scope,
        scopeKey: input.scopeKey ?? null,
        content: input.content,
        reason: result.reason,
      },
    });

    const entry = await fetchEntry(db, id);
    return { kind: 'inserted', entry };
  }

  if (decision === 'update') {
    if (!result.existingId) {
      throw new Error('memory writer: `update` decision requires `existingId`');
    }
    const now = new Date();

    await db
      .update(memoryEntries)
      .set({ content: input.content, updatedAt: now })
      .where(eq(memoryEntries.id, result.existingId));

    await append(db, {
      workspaceId: input.workspaceId,
      kind: 'app.memory.write',
      actorKind: 'slack_user',
      actorId: input.actorId,
      targetKind: 'memory',
      targetId: result.existingId,
      payload: {
        action: 'update',
        scope: input.scope,
        scopeKey: input.scopeKey ?? null,
        content: input.content,
        reason: result.reason,
      },
    });

    const entry = await fetchEntry(db, result.existingId);
    return { kind: 'updated', entry };
  }

  if (decision === 'supersede') {
    if (!result.existingId) {
      throw new Error('memory writer: `supersede` decision requires `existingId`');
    }

    // Mark old row superseded.
    await db
      .update(memoryEntries)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(eq(memoryEntries.id, result.existingId));

    // Insert new active row referencing the superseded one.
    const newId = uuidv7();

    await db.insert(memoryEntries).values({
      id: newId,
      workspaceId: input.workspaceId,
      scope: input.scope,
      scopeKey: input.scopeKey ?? null,
      actorId: input.actorId,
      subjectId: input.subjectId ?? null,
      content: input.content,
      status: 'active',
      supersedesId: result.existingId,
      subjectConsentStatus,
    });

    await append(db, {
      workspaceId: input.workspaceId,
      kind: 'app.memory.supersede',
      actorKind: 'slack_user',
      actorId: input.actorId,
      targetKind: 'memory',
      targetId: newId,
      payload: {
        action: 'supersede',
        oldId: result.existingId,
        scope: input.scope,
        scopeKey: input.scopeKey ?? null,
        content: input.content,
        reason: result.reason,
      },
    });

    const entry = await fetchEntry(db, newId);
    return { kind: 'superseded', oldId: result.existingId, entry };
  }

  // Should be unreachable given ChangePolicyDecision's four states.
  throw new Error(`memory writer: unhandled decision "${String(decision)}"`);
}

async function fetchEntry(db: Database, id: string): Promise<MemoryEntry> {
  const [row] = await db.select().from(memoryEntries).where(eq(memoryEntries.id, id));
  if (!row) {
    throw new Error(`memory writer: could not re-fetch entry id=${id}`);
  }
  return rowToEntry(row);
}
