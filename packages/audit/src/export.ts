/**
 * Chain export tool — admin download of the full audit chain for a workspace.
 *
 * `exportChain(db, workspaceId)` returns every event in `id ASC` order as a
 * JSON-serialisable array.  Hashes are hex-encoded strings (binary is not
 * JSON-safe natively).
 *
 * Intended for:
 *   - Admin download via the Dashboard API (S3).
 *   - Offline integrity audits.
 *   - Forensic review.
 *
 * Performance note: for large chains this will be slow (full table scan).
 * Pagination (cursor-based) is a future additive concern; the interface is
 * intentionally simple for v1.
 */

import { auditEvents } from '@sym/db';
import { asc, eq } from 'drizzle-orm';

import type { WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

/** One entry in the exported chain — hashes are hex strings for JSON safety. */
export interface ExportedAuditEvent {
  id: number;
  workspaceId: string;
  kind: string;
  actorKind: string;
  actorId: string;
  onBehalfOf: string | null;
  targetKind: string | null;
  targetId: string | null;
  payload: unknown;
  prevHash: string | null;
  thisHash: string;
  ts: string;
}

/**
 * Export the full hash chain for a workspace as a JSON-safe array.
 *
 * @param db          - Drizzle Database handle.
 * @param workspaceId - The workspace to export.
 * @returns All audit events in `id ASC` order with hashes as hex strings.
 */
export async function exportChain(
  db: Database,
  workspaceId: WorkspaceId,
): Promise<ExportedAuditEvent[]> {
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

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    actorKind: row.actorKind,
    actorId: row.actorId,
    onBehalfOf: row.onBehalfOf ?? null,
    targetKind: row.targetKind ?? null,
    targetId: row.targetId ?? null,
    payload: row.payloadJson,
    prevHash: row.prevHash ? (row.prevHash as Buffer).toString('hex') : null,
    thisHash: (row.thisHash as Buffer).toString('hex'),
    ts: row.ts.toISOString(),
  }));
}
