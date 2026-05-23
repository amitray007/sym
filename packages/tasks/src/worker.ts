/**
 * Worker loop — polls due tasks, dispatches per kind, marks completed/failed.
 *
 * Usage:
 *   const worker = createWorker({ db, handlers: { turn: myHandler }, config: {} });
 *   await worker.start();
 *   // ...
 *   await worker.stop();
 *
 * Graceful shutdown: stop() signals the loop and waits for the in-flight
 * batch to finish before resolving.
 */

import { append } from '@sym/audit';
import { tasks } from '@sym/db';
import { eq } from 'drizzle-orm';

import { dequeue } from './dequeue.js';
import { applyRetry } from './retry.js';

import type { HandlerMap, TaskConfig, TaskHandlerContext, TaskPayload } from './types.js';
import type { WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

export interface WorkerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateWorkerInput {
  db: Database;
  handlers: HandlerMap;
  config?: TaskConfig;
}

export function createWorker({ db, handlers, config = {} }: CreateWorkerInput): WorkerHandle {
  const pollIntervalMs = config.pollIntervalMs ?? 2_000;
  const batchSize = config.batchSize ?? 5;
  const lockSeconds = config.lockSeconds ?? 300;

  let running = false;
  let stopResolve: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;

  async function processBatch(): Promise<void> {
    const dequeued = await dequeue(db, { batchSize, lockSeconds });

    await Promise.allSettled(
      dequeued.map(async (task) => {
        const workspaceId = task.workspaceId as WorkspaceId;
        const handler = handlers[task.kind];

        if (!handler) {
          // No handler registered for this kind — move to dead_letter immediately.
          await db
            .update(tasks)
            .set({
              status: 'dead_letter',
              lockedUntil: null,
              lastError: `No handler registered for kind: ${task.kind}`,
              completedAt: new Date(),
            })
            .where(eq(tasks.id, task.id));

          await append(db, {
            workspaceId,
            kind: 'app.task.dead_letter',
            actorKind: 'system',
            actorId: 'system',
            targetKind: 'task',
            targetId: task.id,
            payload: {
              taskKind: task.kind,
              reason: 'no_handler',
            },
          });
          return;
        }

        const ctx: TaskHandlerContext = {
          taskId: task.id as TaskHandlerContext['taskId'],
          workspaceId,
          kind: task.kind,
          payload: (task.payloadJson ?? {}) as TaskPayload,
          attempt: task.attempts,
        };

        try {
          const result = await handler(ctx);

          await db
            .update(tasks)
            .set({
              status: 'completed',
              lockedUntil: null,
              completedAt: new Date(),
            })
            .where(eq(tasks.id, task.id));

          await append(db, {
            workspaceId,
            kind: 'app.task.completed',
            actorKind: 'system',
            actorId: 'system',
            targetKind: 'task',
            targetId: task.id,
            payload: {
              taskKind: task.kind,
              attempt: task.attempts,
              summary: result.summary ?? null,
            },
          });
        } catch (err) {
          await applyRetry(db, {
            taskId: task.id,
            workspaceId,
            kind: task.kind,
            attempts: task.attempts,
            maxAttempts: task.maxAttempts,
            error: err,
          });
        }
      }),
    );
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        await processBatch();
      } catch (err) {
        console.error('[tasks:worker] poll error', err);
      }

      if (!running) break;

      await new Promise<void>((resolve) => {
        const tid = setTimeout(resolve, pollIntervalMs);
        // If stop() is called while sleeping, we need to wake up early.
        // We do this by overriding stopResolve temporarily.
        const prevStop = stopResolve;
        stopResolve = () => {
          clearTimeout(tid);
          prevStop?.();
          resolve();
        };
      });
    }

    stopResolve?.();
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      stopPromise = new Promise<void>((res) => {
        stopResolve = res;
      });
      // Run in background — loop() resolves stopPromise when done.
      void loop();
    },

    async stop(): Promise<void> {
      running = false;
      stopResolve?.();
      if (stopPromise) await stopPromise;
    },
  };
}
