/**
 * Soul editor data API.
 *
 * CRUD operations for L1/L2/L3 soul rows.  Every write appends an audit event
 * via `@sym/audit`.  The Dashboard UI calls these directly; no HTTP layer lives
 * here (the Dashboard's API routes are a later chunk).
 *
 * Invariants:
 *   - L0 (`l0_global`) is immutable.  This module never touches it.
 *   - At most one enabled row per (workspaceId, layer, scopeId).
 *   - A upsert pattern is used: if a row already exists it is updated
 *     in-place (preserving the `id`), so the cache invalidation path (which
 *     keys on `id + updated_at`) works correctly.
 */

import { append } from '@sym/audit';
import { soulLayers, uuidv7 } from '@sym/db';
import { and, eq, isNull } from 'drizzle-orm';

import { clearCascadeCache } from './cascade.js';

import type {
  AdminId,
  PersistedSoulLayer,
  SoulLayer,
  SoulLayerId,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface GetSoulLayerOptions {
  workspaceId: WorkspaceId;
  layer: PersistedSoulLayer;
  /** Required for l2_channel and l3_user; must be undefined for l1_workspace. */
  scopeId?: string;
}

export interface UpsertSoulLayerOptions {
  workspaceId: WorkspaceId;
  layer: PersistedSoulLayer;
  scopeId?: string;
  contentMd: string;
  /** The admin making the edit — written to `updated_by_admin_id` and audit. */
  adminId: AdminId;
}

export interface DeleteSoulLayerOptions {
  workspaceId: WorkspaceId;
  layer: PersistedSoulLayer;
  scopeId?: string;
  adminId: AdminId;
}

export interface SoulLayerRow {
  id: SoulLayerId;
  workspaceId: WorkspaceId;
  layer: PersistedSoulLayer;
  scopeId: string | null;
  contentMd: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scopeCondition(layer: PersistedSoulLayer, scopeId: string | undefined) {
  if (layer === 'l1_workspace') {
    return isNull(soulLayers.scopeId);
  }
  if (!scopeId) {
    throw new Error(`soul editor: scopeId is required for layer ${layer}`);
  }
  return eq(soulLayers.scopeId, scopeId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the current soul layer row for a given (workspaceId, layer, scopeId).
 * Returns `null` if no row exists.
 */
export async function getSoulLayer(
  db: Database,
  options: GetSoulLayerOptions,
): Promise<SoulLayerRow | null> {
  const { workspaceId, layer, scopeId } = options;

  const rows = await db
    .select()
    .from(soulLayers)
    .where(
      and(
        eq(soulLayers.workspaceId, workspaceId),
        eq(soulLayers.layer, layer),
        scopeCondition(layer, scopeId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id as SoulLayerId,
    workspaceId: row.workspaceId as WorkspaceId,
    layer: row.layer as PersistedSoulLayer,
    scopeId: row.scopeId,
    contentMd: row.contentMd,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * List all soul layers for a workspace (all enabled + disabled rows).
 */
export async function listSoulLayers(
  db: Database,
  workspaceId: WorkspaceId,
): Promise<SoulLayerRow[]> {
  const rows = await db.select().from(soulLayers).where(eq(soulLayers.workspaceId, workspaceId));

  return rows.map((row) => ({
    id: row.id as SoulLayerId,
    workspaceId: row.workspaceId as WorkspaceId,
    layer: row.layer as PersistedSoulLayer,
    scopeId: row.scopeId,
    contentMd: row.contentMd,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Create or update a soul layer row.
 *
 * If a row already exists for (workspaceId, layer, scopeId), it is updated
 * in-place.  If not, a new row is inserted.  In both cases an `app.soul.update`
 * audit event is appended.
 *
 * Clears the in-process cascade cache so the next turn reads the new value.
 */
export async function upsertSoulLayer(
  db: Database,
  options: UpsertSoulLayerOptions,
): Promise<SoulLayerRow> {
  const { workspaceId, layer, scopeId, contentMd, adminId } = options;

  const existing = await getSoulLayer(db, {
    workspaceId,
    layer,
    ...(scopeId !== undefined ? { scopeId } : {}),
  });

  let row: SoulLayerRow;

  if (existing) {
    // Update in-place.
    const updated = await db
      .update(soulLayers)
      .set({
        contentMd,
        enabled: true,
        updatedAt: new Date(),
        updatedByAdminId: adminId,
      })
      .where(eq(soulLayers.id, existing.id))
      .returning();

    const updatedRow = updated[0];
    if (!updatedRow) throw new Error('soul editor: UPDATE returned no row');

    row = {
      id: updatedRow.id as SoulLayerId,
      workspaceId: updatedRow.workspaceId as WorkspaceId,
      layer: updatedRow.layer as PersistedSoulLayer,
      scopeId: updatedRow.scopeId,
      contentMd: updatedRow.contentMd,
      enabled: updatedRow.enabled,
      createdAt: updatedRow.createdAt,
      updatedAt: updatedRow.updatedAt,
    };
  } else {
    // Insert new row.
    const id = uuidv7();
    const inserted = await db
      .insert(soulLayers)
      .values({
        id,
        workspaceId,
        layer,
        scopeId: scopeId ?? null,
        contentMd,
        enabled: true,
        updatedByAdminId: adminId,
      })
      .returning();

    const insertedRow = inserted[0];
    if (!insertedRow) throw new Error('soul editor: INSERT returned no row');

    row = {
      id: insertedRow.id as SoulLayerId,
      workspaceId: insertedRow.workspaceId as WorkspaceId,
      layer: insertedRow.layer as PersistedSoulLayer,
      scopeId: insertedRow.scopeId,
      contentMd: insertedRow.contentMd,
      enabled: insertedRow.enabled,
      createdAt: insertedRow.createdAt,
      updatedAt: insertedRow.updatedAt,
    };
  }

  // Audit.
  await append(db, {
    workspaceId,
    kind: 'app.soul.update',
    actorKind: 'admin',
    actorId: adminId,
    targetKind: 'soul_layer',
    targetId: row.id,
    payload: {
      layer,
      scopeId: scopeId ?? null,
      action: existing ? 'update' : 'create',
    },
  });

  // Invalidate cache so the next turn sees the new content.
  clearCascadeCache();

  return row;
}

/**
 * Disable (soft-delete) a soul layer row by setting `enabled = false`.
 *
 * The row is preserved for the audit trail.  The cascade resolver ignores
 * disabled rows.  An `app.soul.update` audit event is appended with
 * `action: 'disable'`.
 *
 * Clears the cascade cache.
 */
export async function disableSoulLayer(
  db: Database,
  options: DeleteSoulLayerOptions,
): Promise<void> {
  const { workspaceId, layer, scopeId, adminId } = options;

  const existing = await getSoulLayer(db, {
    workspaceId,
    layer,
    ...(scopeId !== undefined ? { scopeId } : {}),
  });
  if (!existing) {
    // Nothing to delete — idempotent.
    return;
  }

  await db
    .update(soulLayers)
    .set({
      enabled: false,
      updatedAt: new Date(),
      updatedByAdminId: adminId,
    })
    .where(eq(soulLayers.id, existing.id));

  await append(db, {
    workspaceId,
    kind: 'app.soul.update',
    actorKind: 'admin',
    actorId: adminId,
    targetKind: 'soul_layer',
    targetId: existing.id,
    payload: {
      layer,
      scopeId: scopeId ?? null,
      action: 'disable',
    },
  });

  clearCascadeCache();
}

/**
 * Convert a `SoulLayerRow` to the public `SoulLayer` shape used by the cascade.
 */
export function toSoulLayer(row: SoulLayerRow): SoulLayer {
  const layer: SoulLayer = {
    kind: row.layer,
    contentMd: row.contentMd,
  };
  if (row.scopeId !== null) {
    layer.scopeId = row.scopeId;
  }
  return layer;
}
