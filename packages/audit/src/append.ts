/**
 * Audit append primitive.
 *
 * `append(db, input)` is the ONLY sanctioned write path to `auditEvents`.
 * No other code in the monorepo may INSERT into `audit_events` directly.
 *
 * Algorithm (inside a single transaction):
 *
 * 1. Take `pg_advisory_xact_lock(hashtext(workspaceId))` — this serializes
 *    all appends within a workspace, ensuring the hash chain is strictly
 *    linear even under concurrent callers (D-DB-5).  The lock is transaction-
 *    scoped and released automatically when the transaction commits/rolls back.
 *
 * 2. Select the `this_hash` of the latest event for this workspace (ordered
 *    by `id DESC LIMIT 1`) as `prevHash`.  NULL if this is the first event.
 *
 * 3. We compute `thisHash` after INSERT (because the bigserial `id` is
 *    assigned by Postgres).  Two-step approach: INSERT with placeholder hash,
 *    read back the id, compute real hash, UPDATE.  All within one transaction.
 *
 * 4. Check payload JSON size ≤ 64KB before inserting (D-DB-9).  The DB
 *    CHECK constraint is the final guard; we fail early with a clear error.
 *
 * 5. INSERT the row and RETURN it.
 *
 * 6. Fan-out to SSE broadcaster (after the transaction commits).
 *
 * 7. Record OTel spans / counters.
 */

import { auditEvents } from '@sym/db';
import { desc, eq, sql } from 'drizzle-orm';

import { emit } from './broadcaster.js';
import { computeHash, type HashableEventFields } from './hash.js';
import {
  appendCounter,
  ATTR_ACTOR_ID,
  ATTR_ACTOR_KIND,
  ATTR_AUDIT_KIND,
  ATTR_WORKSPACE_ID,
  payloadSizeHistogram,
  tracer,
} from './otel.js';

import type {
  AuditActorKind,
  AuditEvent,
  AuditEventKind,
  JsonValue,
  SlackUserId,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';
import type { PostgresJsTransaction } from 'drizzle-orm/postgres-js';

/** Maximum payload size in bytes (D-DB-9). */
export const MAX_PAYLOAD_BYTES = 65_536;

/** Input shape for appending an audit event. */
export interface AppendInput {
  workspaceId: WorkspaceId;
  kind: AuditEventKind;
  actorKind: AuditActorKind;
  actorId: string;
  onBehalfOf?: string;
  targetKind?: string;
  targetId?: string;
  payload: Record<string, unknown>;
  /** Override the timestamp; defaults to `new Date()`. Useful for testing. */
  ts?: Date;
}

/** Error thrown when payload exceeds the 64KB limit. */
export class PayloadTooLargeError extends Error {
  constructor(actualBytes: number) {
    super(
      `audit append: payload_json exceeds 64KB limit (${actualBytes} bytes). ` +
        `Reduce the payload size or spill large bodies to object storage.`,
    );
    this.name = 'PayloadTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Internal transaction body
// ---------------------------------------------------------------------------

interface InsertedRow {
  id: number;
  workspaceId: WorkspaceId;
  kind: string;
  actorKind: AuditActorKind;
  actorId: string;
  onBehalfOf: string | null;
  targetKind: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  ts: Date;
  prevHash: Buffer | null;
  thisHash: Buffer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTx = PostgresJsTransaction<any, any>;

async function runInsertTx(tx: AnyTx, input: AppendInput, ts: Date): Promise<InsertedRow> {
  // 1. Serialize the workspace's chain with a transaction-scoped advisory lock.
  //    hashtext() is a stable Postgres function: same string → same int4.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}))`);

  // 2. Find the previous tail hash for this workspace.
  const [latest] = await tx
    .select({ thisHash: auditEvents.thisHash })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, input.workspaceId))
    .orderBy(desc(auditEvents.id))
    .limit(1);

  const prevHash: Buffer | null = (latest?.thisHash as Buffer | undefined) ?? null;

  // 3a. INSERT with a placeholder this_hash — we need the DB-assigned id first.
  const placeholderHash = prevHash ?? Buffer.alloc(32, 0);

  const [row] = await tx
    .insert(auditEvents)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      actorKind: input.actorKind,
      actorId: input.actorId,
      onBehalfOf: input.onBehalfOf ?? null,
      targetKind: input.targetKind ?? null,
      targetId: input.targetId ?? null,
      payloadJson: input.payload,
      prevHash,
      thisHash: placeholderHash,
      ts,
    })
    .returning({
      id: auditEvents.id,
      ts: auditEvents.ts,
      payloadJson: auditEvents.payloadJson,
    });

  if (!row) {
    throw new Error('audit append: INSERT returned no row');
  }

  // 3b. Compute the real hash with the DB-assigned id and the DB-canonical ts +
  //     payload (read back via RETURNING) so verify recomputes the same bytes.
  const fields: HashableEventFields = {
    id: row.id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    actorKind: input.actorKind,
    actorId: input.actorId,
    onBehalfOf: input.onBehalfOf ?? null,
    targetKind: input.targetKind ?? null,
    targetId: input.targetId ?? null,
    ts: row.ts,
    payload: row.payloadJson as JsonValue,
  };
  const thisHash = computeHash(prevHash, fields);

  // 3c. UPDATE the row with the correct hash.
  await tx.update(auditEvents).set({ thisHash }).where(eq(auditEvents.id, row.id));

  return {
    id: row.id,
    workspaceId: input.workspaceId as WorkspaceId,
    kind: input.kind,
    actorKind: input.actorKind,
    actorId: input.actorId,
    onBehalfOf: input.onBehalfOf ?? null,
    targetKind: input.targetKind ?? null,
    targetId: input.targetId ?? null,
    payload: row.payloadJson as Record<string, unknown>,
    ts: row.ts,
    prevHash,
    thisHash,
  };
}

/**
 * Append one audit event to the hash chain.
 *
 * Runs inside a single Postgres transaction with an advisory lock so the
 * per-workspace chain is strictly linear.
 *
 * @param db    - A Drizzle `Database` handle (not already in a transaction).
 * @param input - The event data to append.
 * @returns The inserted `AuditEvent` (with id and ts filled in by Postgres).
 */
export async function append(db: Database, input: AppendInput): Promise<AuditEvent> {
  const payloadStr = JSON.stringify(input.payload);
  const payloadBytes = Buffer.byteLength(payloadStr, 'utf8');

  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(payloadBytes);
  }

  return tracer.startActiveSpan('audit.append', async (span) => {
    try {
      span.setAttribute(ATTR_WORKSPACE_ID, input.workspaceId);
      span.setAttribute(ATTR_AUDIT_KIND, input.kind);
      span.setAttribute(ATTR_ACTOR_KIND, input.actorKind);
      span.setAttribute(ATTR_ACTOR_ID, input.actorId);

      const ts = input.ts ?? new Date();
      const inserted = await db.transaction((tx) => runInsertTx(tx as AnyTx, input, ts));

      // 4. Record OTel metrics after the transaction commits.
      appendCounter.add(1, {
        [ATTR_WORKSPACE_ID]: input.workspaceId,
        [ATTR_AUDIT_KIND]: input.kind,
      });
      payloadSizeHistogram.record(payloadBytes, {
        [ATTR_WORKSPACE_ID]: input.workspaceId,
      });

      // Build the public AuditEvent — optional properties absent when null
      // (required by exactOptionalPropertyTypes).
      const event: AuditEvent = {
        id: inserted.id as AuditEvent['id'],
        workspaceId: inserted.workspaceId,
        kind: inserted.kind,
        actorKind: inserted.actorKind,
        actorId: inserted.actorId,
        payload: inserted.payload as AuditEvent['payload'],
        ts: inserted.ts,
      };
      if (inserted.onBehalfOf !== null) {
        event.onBehalfOf = inserted.onBehalfOf as SlackUserId;
      }
      if (inserted.targetKind !== null) {
        event.targetKind = inserted.targetKind;
      }
      if (inserted.targetId !== null) {
        event.targetId = inserted.targetId;
      }

      // 5. SSE fan-out (fire-and-forget; does not affect the transaction result).
      emit(event);

      span.setStatus({ code: 1 /* OK */ });
      return event;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: 2 /* ERROR */ });
      throw err;
    } finally {
      span.end();
    }
  });
}
