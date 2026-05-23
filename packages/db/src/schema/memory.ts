import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, check, index, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';

import { uuidv7 } from '../uuid.js';
import { createdAt, tstz, updatedAt } from './_shared.js';
import { auditEvents } from './audit.js';
import { workspaces } from './workspaces.js';

export const memoryScopeEnum = pgEnum('memory_scope', [
  'workspace',
  'channel',
  'thread',
  'dm',
  'custom_relational',
]);

export const memoryStatusEnum = pgEnum('memory_status', ['active', 'superseded', 'forgotten']);

export const subjectConsentStatusEnum = pgEnum('subject_consent_status', [
  'pending',
  'accepted',
  'rejected',
  'not_applicable',
]);

/**
 * Five-scope memory with change-policy lifecycle. The retrieval GATE runs in
 * `@sym/memory` (in code), NOT here — the schema exposes everything and access
 * control is enforced at retrieval. `pending`-consent custom-relational rows
 * are written but invisible to retrieval until the subject accepts.
 *
 * `scope_key`: NULL for workspace; channel_id (channel); thread_ts (thread);
 * slack_user_id (dm); composite `actor:subject` (custom_relational).
 */
export const memoryEntries = pgTable(
  'memory_entries',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: memoryScopeEnum('scope').notNull(),
    scopeKey: text('scope_key'),
    actorId: text('actor_id').notNull(),
    subjectId: text('subject_id'),
    content: text('content').notNull(),
    status: memoryStatusEnum('status').notNull().default('active'),
    supersedesId: text('supersedes_id').references((): AnyPgColumn => memoryEntries.id, {
      onDelete: 'set null',
    }),
    subjectConsentStatus: subjectConsentStatusEnum('subject_consent_status')
      .notNull()
      .default('not_applicable'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastReferencedAt: tstz('last_referenced_at'),
    auditEventId: bigint('audit_event_id', { mode: 'number' }).references(() => auditEvents.id),
  },
  (t) => [
    // Primary retrieval path.
    index('memory_entries_retrieval').on(t.workspaceId, t.scope, t.scopeKey, t.status),
    // Custom-relational lookups by subject.
    index('memory_entries_subject')
      .on(t.workspaceId, t.subjectId, t.status)
      .where(sql`${t.subjectId} IS NOT NULL`),
    check(
      'memory_entries_workspace_scope_key',
      sql`${t.scope} != 'workspace' OR ${t.scopeKey} IS NULL`,
    ),
    check(
      'memory_entries_channel_thread_dm_shape',
      sql`${t.scope} NOT IN ('channel','thread','dm') OR (${t.scopeKey} IS NOT NULL AND ${t.subjectId} IS NULL)`,
    ),
    check(
      'memory_entries_custom_relational_shape',
      sql`${t.scope} != 'custom_relational' OR (${t.subjectId} IS NOT NULL AND ${t.subjectConsentStatus} != 'not_applicable')`,
    ),
  ],
);
