/**
 * Retry policy — exponential backoff + dead_letter promotion.
 *
 * After a handler throws, the worker calls `applyRetry`:
 *  - If attempts < maxAttempts → update status='pending', due_at=now()+backoff, last_error=<msg>
 *  - If attempts >= maxAttempts → update status='dead_letter'
 *
 * Backoff formula: min(base * 2^(attempt-1), cap)
 *   attempt 1 → 30 s
 *   attempt 2 → 60 s
 *   attempt 3 → 120 s
 *   attempt 4 → 240 s
 *   attempt 5 → 300 s (capped)
 */

import { append } from '@sym/audit';
import { tasks } from '@sym/db';
import { eq, sql } from 'drizzle-orm';

import type { WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 300;

export function backoffSeconds(attempt: number): number {
  const raw = BACKOFF_BASE_SECONDS * Math.pow(2, attempt - 1);
  return Math.min(raw, BACKOFF_CAP_SECONDS);
}

export interface ApplyRetryInput {
  taskId: string;
  workspaceId: WorkspaceId;
  kind: string;
  attempts: number;
  maxAttempts: number;
  error: unknown;
}

export async function applyRetry(db: Database, input: ApplyRetryInput): Promise<void> {
  const errorMsg = input.error instanceof Error ? input.error.message : String(input.error);
  const willRetry = input.attempts < input.maxAttempts;

  if (willRetry) {
    const delaySec = backoffSeconds(input.attempts);
    await db
      .update(tasks)
      .set({
        status: 'pending',
        lockedUntil: null,
        lastError: errorMsg.slice(0, 2000),
        dueAt: sql`now() + (${delaySec} * interval '1 second')`,
      })
      .where(eq(tasks.id, input.taskId));

    await append(db, {
      workspaceId: input.workspaceId,
      kind: 'app.task.failed',
      actorKind: 'system',
      actorId: 'system',
      targetKind: 'task',
      targetId: input.taskId,
      payload: {
        taskKind: input.kind,
        attempt: input.attempts,
        maxAttempts: input.maxAttempts,
        nextDelaySec: delaySec,
        error: errorMsg.slice(0, 1000),
        willRetry: true,
      },
    });
  } else {
    await db
      .update(tasks)
      .set({
        status: 'dead_letter',
        lockedUntil: null,
        lastError: errorMsg.slice(0, 2000),
        completedAt: new Date(),
      })
      .where(eq(tasks.id, input.taskId));

    await append(db, {
      workspaceId: input.workspaceId,
      kind: 'app.task.dead_letter',
      actorKind: 'system',
      actorId: 'system',
      targetKind: 'task',
      targetId: input.taskId,
      payload: {
        taskKind: input.kind,
        attempt: input.attempts,
        maxAttempts: input.maxAttempts,
        error: errorMsg.slice(0, 1000),
        willRetry: false,
      },
    });
  }
}
