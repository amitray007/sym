/**
 * Integration tests for the worker loop — dispatch + completed/failed lifecycle.
 *
 * Gated on DATABASE_URL — skips cleanly without one.
 */

import { createDb, tasks, workspaces } from '@sym/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueue } from './enqueue.js';
import { createWorker } from './worker.js';

import type { WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const suite = databaseUrl ? describe : describe.skip;

suite('@sym/tasks worker dispatch (integration)', () => {
  const { db, close } = createDb(databaseUrl ?? '', { max: 5 }) as {
    db: Database;
    close: () => Promise<void>;
  };
  const teamId = `T_TASKS_W_${Date.now()}`;
  let workspaceId: WorkspaceId;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ slackTeamId: teamId, name: 'Tasks Worker Integration Test' })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error('failed to insert test workspace');
    workspaceId = ws.id as WorkspaceId;
  });

  afterAll(async () => {
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.slackTeamId, teamId));
    await close();
  });

  it('marks task completed when handler succeeds', async () => {
    const { taskId } = await enqueue(db, {
      workspaceId,
      kind: 'test.succeed',
      payload: { msg: 'hello' },
    });

    const worker = createWorker({
      db,
      handlers: {
        'test.succeed': async () => ({ summary: 'done' }),
      },
      config: { pollIntervalMs: 50, batchSize: 5 },
    });

    await worker.start();
    // Give the worker time to process.
    await new Promise<void>((r) => setTimeout(r, 300));
    await worker.stop();

    const [row] = await db
      .select({ status: tasks.status, completedAt: tasks.completedAt })
      .from(tasks)
      .where(eq(tasks.id, taskId));

    expect(row?.status).toBe('completed');
    expect(row?.completedAt).toBeInstanceOf(Date);
  });

  it('marks task failed and schedules retry when handler throws', async () => {
    const { taskId } = await enqueue(db, {
      workspaceId,
      kind: 'test.fail_once',
      payload: {},
    });

    const worker = createWorker({
      db,
      handlers: {
        'test.fail_once': async () => {
          throw new Error('intentional test failure');
        },
      },
      config: { pollIntervalMs: 50, batchSize: 5 },
    });

    await worker.start();
    await new Promise<void>((r) => setTimeout(r, 300));
    await worker.stop();

    const [row] = await db
      .select({ status: tasks.status, lastError: tasks.lastError, attempts: tasks.attempts })
      .from(tasks)
      .where(eq(tasks.id, taskId));

    // After one failure the task should be back to pending (will retry).
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toContain('intentional test failure');
    expect(row?.attempts).toBe(1);
  });

  it('moves task to dead_letter after max_attempts', async () => {
    const { taskId } = await enqueue(db, {
      workspaceId,
      kind: 'test.always_fail',
      payload: {},
      maxAttempts: 1,
    });

    const worker = createWorker({
      db,
      handlers: {
        'test.always_fail': async () => {
          throw new Error('always fails');
        },
      },
      config: { pollIntervalMs: 50, batchSize: 5 },
    });

    await worker.start();
    await new Promise<void>((r) => setTimeout(r, 300));
    await worker.stop();

    const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));

    expect(row?.status).toBe('dead_letter');
  });
});
