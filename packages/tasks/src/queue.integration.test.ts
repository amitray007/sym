/**
 * Integration tests for enqueue/dequeue and SKIP LOCKED concurrency.
 *
 * Gated on DATABASE_URL — skips cleanly without one.
 */

import { createDb, tasks, workspaces } from '@sym/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dequeue } from './dequeue.js';
import { enqueue } from './enqueue.js';

import type { WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl ? describe : describe.skip;

suite('@sym/tasks enqueue/dequeue (integration)', () => {
  const { db, close } = createDb(databaseUrl ?? '', { max: 5 }) as {
    db: Database;
    close: () => Promise<void>;
  };
  const teamId = `T_TASKS_Q_${Date.now()}`;
  let workspaceId: WorkspaceId;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ slackTeamId: teamId, name: 'Tasks Queue Integration Test' })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error('failed to insert test workspace');
    workspaceId = ws.id as WorkspaceId;
  });

  afterAll(async () => {
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.slackTeamId, teamId));
    await close();
  });

  it('enqueues a task and dequeues it', async () => {
    const { taskId } = await enqueue(db, {
      workspaceId,
      kind: 'test.noop',
      payload: { hello: 'world' },
    });
    expect(taskId).toBeTruthy();

    const batch = await dequeue(db, { batchSize: 1, lockSeconds: 10 });
    const found = batch.find((t) => t.id === taskId);
    expect(found).toBeDefined();
    expect(found?.kind).toBe('test.noop');
    expect(found?.attempts).toBe(1);
    expect(found?.lockedUntil).toBeInstanceOf(Date);
  });

  it('idempotent enqueue returns the same task id', async () => {
    const key = `idem-test-${Date.now()}`;

    const r1 = await enqueue(db, {
      workspaceId,
      kind: 'test.idem',
      payload: {},
      idempotencyKey: key,
    });

    const r2 = await enqueue(db, {
      workspaceId,
      kind: 'test.idem',
      payload: {},
      idempotencyKey: key,
    });

    expect(r1.taskId).toBe(r2.taskId);
    expect(r2.deduplicated).toBe(true);
  });

  it('SKIP LOCKED: two concurrent workers do not claim the same task', async () => {
    // Enqueue exactly one task.
    const { taskId } = await enqueue(db, {
      workspaceId,
      kind: 'test.skip_locked',
      payload: {},
    });

    // Create a second DB connection to simulate a concurrent worker.
    const { db: db2, close: close2 } = createDb(databaseUrl ?? '', { max: 1 });

    try {
      // Both workers race to dequeue. Only one should get the task.
      const [batch1, batch2] = await Promise.all([
        dequeue(db, { batchSize: 5, lockSeconds: 60 }),
        dequeue(db2 as unknown as Database, { batchSize: 5, lockSeconds: 60 }),
      ]);

      const claimedBy1 = batch1.some((t) => t.id === taskId);
      const claimedBy2 = batch2.some((t) => t.id === taskId);

      // Exactly one worker should have claimed the task.
      expect(claimedBy1 || claimedBy2).toBe(true);
      expect(claimedBy1 && claimedBy2).toBe(false);
    } finally {
      await close2();
    }
  });
});
