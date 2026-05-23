/**
 * Hash-chain verifier.
 *
 * `verifyChain(db, workspaceId)` walks every audit event for the workspace in
 * `id` ascending order, recomputes `thisHash` from `prevHash + fields`, and
 * detects the first inconsistency (tampered row, missing row, or a hash that
 * doesn't match the stored value).
 *
 * This is the integrity check.  It should be run:
 *   - In CI after every migration / seed.
 *   - As a periodic background job in production.
 *   - On-demand via the admin export tool.
 */

import { auditEvents } from '@sym/db';
import { asc, eq } from 'drizzle-orm';

import { computeHash, type HashableEventFields } from './hash.js';
import { ATTR_WORKSPACE_ID, chainBreakCounter, tracer } from './otel.js';

import type { JsonValue, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

/** Result when the chain is intact. */
export interface ChainOk {
  ok: true;
  /** Total events verified. */
  count: number;
}

/** Result when the chain has a break. */
export interface ChainBreak {
  ok: false;
  /** The `id` of the first event whose hash does not match. */
  breakAtId: number;
  /** Human-readable explanation. */
  reason: string;
  /** Events verified before the break. */
  countVerified: number;
}

export type VerifyResult = ChainOk | ChainBreak;

/**
 * Verify the hash chain for a workspace.
 *
 * Walks events in `id ASC` order, recomputing each `thisHash` from the
 * preceding event's `thisHash` as `prevHash`.
 *
 * @param db          - Drizzle Database handle (read-only queries).
 * @param workspaceId - The workspace whose chain to verify.
 * @returns A `VerifyResult` — `ok: true` or the first break found.
 */
export async function verifyChain(db: Database, workspaceId: WorkspaceId): Promise<VerifyResult> {
  return tracer.startActiveSpan('audit.verify_chain', async (span) => {
    try {
      span.setAttribute(ATTR_WORKSPACE_ID, workspaceId);

      const rows = await db
        .select({
          id: auditEvents.id,
          workspaceId: auditEvents.workspaceId,
          kind: auditEvents.kind,
          actorKind: auditEvents.actorKind,
          actorId: auditEvents.actorId,
          onBehalfOf: auditEvents.onBehalfOf,
          targetKind: auditEvents.targetKind,
          targetId: auditEvents.targetId,
          payloadJson: auditEvents.payloadJson,
          prevHash: auditEvents.prevHash,
          thisHash: auditEvents.thisHash,
          ts: auditEvents.ts,
        })
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, workspaceId))
        .orderBy(asc(auditEvents.id));

      let expectedPrevHash: Buffer | null = null;
      let countVerified = 0;

      for (const row of rows) {
        // Verify that the stored prevHash matches what we expect.
        const storedPrev = (row.prevHash as Buffer | null) ?? null;
        if (!bufferEqual(storedPrev, expectedPrevHash)) {
          const result: ChainBreak = {
            ok: false,
            breakAtId: row.id,
            reason: `event id=${row.id}: stored prev_hash does not match expected value`,
            countVerified,
          };
          chainBreakCounter.add(1, { [ATTR_WORKSPACE_ID]: workspaceId });
          span.setStatus({ code: 2 /* ERROR */ });
          return result;
        }

        // Recompute thisHash from prevHash + fields.
        const fields: HashableEventFields = {
          id: row.id,
          workspaceId: row.workspaceId,
          kind: row.kind,
          actorKind: row.actorKind,
          actorId: row.actorId,
          onBehalfOf: row.onBehalfOf ?? null,
          targetKind: row.targetKind ?? null,
          targetId: row.targetId ?? null,
          ts: row.ts,
          payload: row.payloadJson as JsonValue,
        };
        const recomputed = computeHash(expectedPrevHash, fields);
        const stored = row.thisHash as Buffer;

        if (!recomputed.equals(stored)) {
          const result: ChainBreak = {
            ok: false,
            breakAtId: row.id,
            reason:
              `event id=${row.id}: stored this_hash (${stored.toString('hex')}) ` +
              `does not match recomputed hash (${recomputed.toString('hex')})`,
            countVerified,
          };
          chainBreakCounter.add(1, { [ATTR_WORKSPACE_ID]: workspaceId });
          span.setStatus({ code: 2 /* ERROR */ });
          return result;
        }

        expectedPrevHash = recomputed;
        countVerified += 1;
      }

      const ok: ChainOk = { ok: true, count: countVerified };
      span.setStatus({ code: 1 /* OK */ });
      return ok;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: 2 /* ERROR */ });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Compare two nullable Buffers for equality. */
function bufferEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}
