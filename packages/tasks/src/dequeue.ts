/**
 * Dequeue — Postgres-native SKIP LOCKED pop.
 *
 * Algorithm:
 *   BEGIN;
 *   SELECT id FROM tasks
 *     WHERE status = 'pending' AND due_at <= now()
 *     ORDER BY due_at ASC
 *     LIMIT :batchSize
 *     FOR UPDATE SKIP LOCKED;
 *   UPDATE tasks SET status='running', locked_until=now()+:lockSeconds, attempts=attempts+1, started_at=now()
 *     WHERE id IN (<selected ids>)
 *     RETURNING *;
 *   COMMIT;
 *
 * SKIP LOCKED ensures concurrent workers never double-process the same row.
 * Rows locked by another transaction are silently skipped and picked up in a
 * later poll cycle or by another worker instance.
 */

import { tasks } from '@sym/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';

import type { Database } from '@sym/db';

export interface DequeuedTask {
  id: string;
  workspaceId: string;
  kind: string;
  payloadJson: unknown;
  attempts: number;
  maxAttempts: number;
  lockedUntil: Date;
}

export interface DequeueOptions {
  batchSize?: number;
  lockSeconds?: number;
}

/**
 * Atomically claim up to `batchSize` due pending tasks.
 *
 * Returns an empty array when no tasks are ready — callers should back off
 * and retry after `pollIntervalMs`.
 */
export async function dequeue(db: Database, opts: DequeueOptions = {}): Promise<DequeuedTask[]> {
  const batchSize = opts.batchSize ?? 5;
  const lockSeconds = opts.lockSeconds ?? 300;

  return db.transaction(async (tx) => {
    // Phase 1: SELECT the ids of claimable tasks using SKIP LOCKED.
    // We cast through unknown to avoid the raw-sql result typing gap.
    const candidates = (await tx.execute(
      sql`
        SELECT id FROM tasks
        WHERE status = 'pending'
          AND due_at <= now()
        ORDER BY due_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `,
    )) as unknown as { id: string }[];

    if (candidates.length === 0) {
      return [];
    }

    const ids = candidates.map((r) => r.id);

    // Phase 2: UPDATE the selected rows to 'running'.
    const rows = await tx
      .update(tasks)
      .set({
        status: 'running',
        lockedUntil: sql`now() + (${lockSeconds} * interval '1 second')`,
        attempts: sql`${tasks.attempts} + 1`,
        startedAt: new Date(),
        // Clear any idempotency marker from last_error on first actual run
        lastError: sql`CASE WHEN ${tasks.lastError} LIKE 'idem:%' THEN NULL ELSE ${tasks.lastError} END`,
      })
      .where(and(inArray(tasks.id, ids), eq(tasks.status, 'pending'), lte(tasks.dueAt, new Date())))
      .returning({
        id: tasks.id,
        workspaceId: tasks.workspaceId,
        kind: tasks.kind,
        payloadJson: tasks.payloadJson,
        attempts: tasks.attempts,
        maxAttempts: tasks.maxAttempts,
        lockedUntil: tasks.lockedUntil,
      });

    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      kind: r.kind,
      payloadJson: r.payloadJson,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      lockedUntil: r.lockedUntil as Date,
    }));
  });
}
