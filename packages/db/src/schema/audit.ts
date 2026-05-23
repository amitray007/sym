import { sql } from 'drizzle-orm';
import { bigserial, check, index, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';

import { tstz } from './_shared.js';
import { workspaces } from './workspaces.js';
import { bytea } from '../columns/bytea.js';

export const auditActorKindEnum = pgEnum('audit_actor_kind', [
  'slack_user',
  'admin',
  'system',
  'sandbox',
]);

/**
 * Append-only, hash-chained audit log. `id` is bigserial (strict ordering;
 * never exposed outside the audit subsystem). The chain is per-workspace and
 * serialized at append time via a Postgres advisory lock keyed on the
 * workspace (D-DB-5) — `this_hash = sha256(prev_hash ‖ canonical_json(rest))`.
 *
 * `kind` is an OPEN namespace (text, not enum): `app.memory.write`,
 * `gen_ai.completion`, `messaging.slack.send`, `app.lease.issue`, … —
 * conventions in specs/logging/semantics.md. Payloads are capped at 64KB
 * (D-DB-9); oversize bodies will spill to object storage later.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    actorKind: auditActorKindEnum('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    onBehalfOf: text('on_behalf_of'),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    payloadJson: jsonb('payload_json').notNull(),
    prevHash: bytea('prev_hash'),
    thisHash: bytea('this_hash').notNull(),
    ts: tstz('ts').notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_ws_ts').on(t.workspaceId, t.ts),
    index('audit_events_ws_kind_ts').on(t.workspaceId, t.kind, t.ts),
    check('audit_events_payload_size', sql`octet_length(${t.payloadJson}::text) <= 65536`),
  ],
);
