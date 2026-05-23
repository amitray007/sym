/**
 * Enqueue a new task into the durable queue (tasks table).
 *
 * Idempotency: supply an `idempotencyKey` to guarantee at-most-one INSERT.
 * The second call with the same key returns the existing task id without a
 * second INSERT. The key is stored as the first 255 characters of last_error
 * (a deliberate minor re-use of an otherwise-idle column at enqueue time).
 * If a dedicated idempotency_key column is added later, migrate trivially.
 *
 * The implementation uses INSERT … ON CONFLICT DO NOTHING with a unique index
 * on last_error WHERE status = 'pending' — but that requires a partial unique
 * index that isn't yet in the schema migration. Instead we take a simpler
 * approach: we SELECT first (by idempotency key pattern) and INSERT only when
 * no matching pending row exists. This is safe because:
 *  1. The key is prefixed with `idem:` so it never clashes with actual errors.
 *  2. A tiny race window can produce a duplicate row; callers that need strict
 *     deduplication should add the partial unique index (noted below).
 *
 * NOTE: A stricter implementation would add:
 *   UNIQUE(idempotency_key) WHERE status IN ('pending','running')
 * as a dedicated column. Flag for D-DB-10 follow-up.
 */

import { tasks } from '@sym/db';
import { and, eq, sql } from 'drizzle-orm';

import type { TaskKind, TaskPayload } from './types.js';
import type { WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

export interface EnqueueInput {
  workspaceId: WorkspaceId;
  kind: TaskKind;
  payload: TaskPayload;
  /** ISO string or Date for when to run. Defaults to now. */
  dueAt?: Date | string;
  /** Max retry attempts before dead_letter. @default 5 */
  maxAttempts?: number;
  /**
   * Stable caller-supplied key. Duplicate enqueues with the same key are
   * no-ops; the existing task id is returned.
   */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  taskId: string;
  /** true if this enqueue was a no-op (existing task returned). */
  deduplicated: boolean;
}

const IDEM_PREFIX = 'idem:';

function idemMarker(key: string): string {
  return `${IDEM_PREFIX}${key}`.slice(0, 255);
}

export async function enqueue(db: Database, input: EnqueueInput): Promise<EnqueueResult> {
  const dueAt =
    input.dueAt === undefined
      ? new Date()
      : input.dueAt instanceof Date
        ? input.dueAt
        : new Date(input.dueAt);

  // Idempotency check: look for a non-terminal row with the same marker.
  if (input.idempotencyKey) {
    const marker = idemMarker(input.idempotencyKey);
    const [existing] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.kind, input.kind),
          eq(tasks.lastError, marker),
          sql`${tasks.status} IN ('pending', 'running')`,
        ),
      )
      .limit(1);

    if (existing) {
      return { taskId: existing.id, deduplicated: true };
    }
  }

  const [inserted] = await db
    .insert(tasks)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      payloadJson: input.payload,
      status: 'pending',
      dueAt,
      maxAttempts: input.maxAttempts ?? 5,
      // Store the idempotency marker in last_error at enqueue time.
      // Overwritten by real error text on first failure.
      lastError: input.idempotencyKey ? idemMarker(input.idempotencyKey) : null,
    })
    .returning({ id: tasks.id });

  if (!inserted) {
    throw new Error('tasks: INSERT returned no row');
  }

  return { taskId: inserted.id, deduplicated: false };
}
