import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { bytea } from '../columns/bytea.js';
import { uuidv7 } from '../uuid.js';
import { createdAt, tstz } from './_shared.js';
import { conversations } from './runtime.js';
import { workspaces } from './workspaces.js';

export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'dead_letter',
]);

/**
 * Durable queue. One table with a `kind` discriminant (D-DB-10) — pop pattern
 * is `SELECT ... FOR UPDATE SKIP LOCKED`. `kind` examples: turn, digest,
 * pr_watcher.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    status: taskStatusEnum('status').notNull().default('pending'),
    dueAt: tstz('due_at').notNull().defaultNow(),
    lockedUntil: tstz('locked_until'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    createdAt: createdAt(),
    startedAt: tstz('started_at'),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    // The hot path: due pending tasks.
    index('tasks_pending_due')
      .on(t.status, t.dueAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Slice resumption blobs — serialized kernel state, one per
 * (conversation, slice). `version` is the kernel state schema version
 * (D-DB-6: starts at 1). Purged after `expires_at` by a cleanup job.
 */
export const checkpoints = pgTable(
  'checkpoints',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    sliceId: text('slice_id').notNull(),
    version: integer('version').notNull(),
    stateBlob: bytea('state_blob').notNull(),
    createdAt: createdAt(),
    consumedAt: tstz('consumed_at'),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('checkpoints_conversation_slice').on(t.conversationId, t.sliceId),
    index('checkpoints_unconsumed_expiry')
      .on(t.expiresAt)
      .where(sql`${t.consumedAt} IS NULL`),
  ],
);
