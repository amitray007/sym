/**
 * Soul cascade resolver.
 *
 * Resolves L0 (built-in) + L1 (workspace) + L2 (channel) + L3 (user) layers
 * into a single `SoulCascade`.  More-specific layers override less-specific
 * ones, CSS-style.
 *
 * Override semantics:
 *   effectiveMd = L0 + (L1 overrides L0) + (L2 overrides the above) + (L3 overrides all)
 *
 * Concretely, layers are concatenated in order: L0 → L1 → L2 → L3.  Each
 * layer's content is appended with a separator, so the last layer effectively
 * "wins" for any instructions it re-states.  Callers (the tone-rewrite prompt)
 * are expected to use the `effectiveMd` as a system-level voice instruction.
 *
 * Live-reload strategy:
 *   The cache is keyed on `(workspaceId, channelId?, userId?)` and stores the
 *   latest `updated_at` timestamps seen for each layer.  On the next request,
 *   if any row's `updated_at` is newer than the cached value, the cache is
 *   invalidated and the full set of rows is re-fetched.  This gives
 *   sub-request freshness without restarting the process.
 */

import { soulLayers } from '@sym/db';
import { and, eq } from 'drizzle-orm';

import { L0_CONTENT_MD } from './l0.js';

import type { SoulCascade, SoulLayer, SoulLayerKind, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  cascade: SoulCascade;
  /** Map from soul_layers.id → updated_at epoch ms.  Used for invalidation. */
  updatedAts: Map<string, number>;
}

/** In-process cache.  Lives for the lifetime of the Node process. */
const cache = new Map<string, CacheEntry>();

function cacheKey(
  workspaceId: string,
  channelId: string | undefined,
  userId: string | undefined,
): string {
  return `${workspaceId}|${channelId ?? ''}|${userId ?? ''}`;
}

// ---------------------------------------------------------------------------
// DB fetch helpers
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  layer: 'l1_workspace' | 'l2_channel' | 'l3_user';
  scopeId: string | null;
  contentMd: string;
  updatedAt: Date;
}

async function fetchRows(
  db: Database,
  workspaceId: WorkspaceId,
  channelId: string | undefined,
  userId: string | undefined,
): Promise<RawRow[]> {
  // One query that fetches all relevant rows for this (workspace, channel, user).
  // We want:
  //   - The l1_workspace row (scope_id IS NULL)
  //   - The l2_channel row for channelId (if provided)
  //   - The l3_user row for userId (if provided)
  //
  // Rather than three round-trips we do one query with OR conditions and filter
  // in JS.  The result set is at most 3 rows so there's no performance concern.

  const rows = await db
    .select({
      id: soulLayers.id,
      layer: soulLayers.layer,
      scopeId: soulLayers.scopeId,
      contentMd: soulLayers.contentMd,
      updatedAt: soulLayers.updatedAt,
    })
    .from(soulLayers)
    .where(and(eq(soulLayers.workspaceId, workspaceId), eq(soulLayers.enabled, true)));

  // Filter to only the rows relevant to this specific cascade context.
  return rows.filter((row) => {
    if (row.layer === 'l1_workspace') return true;
    if (row.layer === 'l2_channel' && channelId && row.scopeId === channelId) return true;
    if (row.layer === 'l3_user' && userId && row.scopeId === userId) return true;
    return false;
  }) as RawRow[];
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

const LAYER_ORDER: SoulLayerKind[] = ['l0_global', 'l1_workspace', 'l2_channel', 'l3_user'];

function buildCascade(rows: RawRow[]): SoulCascade {
  // Build the ordered layer list starting from L0.
  const layers: SoulLayer[] = [{ kind: 'l0_global', contentMd: L0_CONTENT_MD }];

  // Index rows by layer for ordered insertion.
  const byLayer = new Map<string, RawRow>();
  for (const row of rows) {
    byLayer.set(row.layer, row);
  }

  const persistedOrder: ('l1_workspace' | 'l2_channel' | 'l3_user')[] = [
    'l1_workspace',
    'l2_channel',
    'l3_user',
  ];

  for (const kind of persistedOrder) {
    const row = byLayer.get(kind);
    if (row) {
      const layer: SoulLayer = { kind, contentMd: row.contentMd };
      if (row.scopeId !== null) {
        layer.scopeId = row.scopeId;
      }
      layers.push(layer);
    }
  }

  // effectiveMd: concatenate all layers in order, separated by a clear divider.
  // The tone-rewrite prompt uses this as a unified voice instruction.
  const effectiveMd = layers
    .map((l) => l.contentMd.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');

  return { layers, effectiveMd };
}

// ---------------------------------------------------------------------------
// Invalidation check
// ---------------------------------------------------------------------------

function isStale(cached: CacheEntry, freshRows: RawRow[]): boolean {
  if (freshRows.length !== cached.updatedAts.size) return true;

  for (const row of freshRows) {
    const cachedTs = cached.updatedAts.get(row.id);
    if (cachedTs === undefined) return true;
    if (row.updatedAt.getTime() !== cachedTs) return true;
  }

  return false;
}

function makeUpdatedAts(rows: RawRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const row of rows) {
    m.set(row.id, row.updatedAt.getTime());
  }
  return m;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolveCascadeOptions {
  workspaceId: WorkspaceId;
  channelId?: string;
  userId?: string;
}

/**
 * Resolve the soul cascade for a (workspace, channel?, user?) context.
 *
 * Always returns a `SoulCascade` with at least L0.  L1/L2/L3 rows are fetched
 * from the database and cached per-context.  The cache is invalidated
 * automatically when any row's `updated_at` changes (live-reload without
 * restart).
 *
 * @param db      - A Drizzle Database handle.
 * @param options - The context for which to resolve the cascade.
 */
export async function resolveCascade(
  db: Database,
  options: ResolveCascadeOptions,
): Promise<SoulCascade> {
  const { workspaceId, channelId, userId } = options;
  const key = cacheKey(workspaceId, channelId, userId);

  // Always fetch rows (one cheap query) to check updated_at for invalidation.
  const freshRows = await fetchRows(db, workspaceId, channelId, userId);

  const cached = cache.get(key);
  if (cached && !isStale(cached, freshRows)) {
    return cached.cascade;
  }

  // Cache miss or stale — recompute.
  const cascade = buildCascade(freshRows);
  cache.set(key, {
    cascade,
    updatedAts: makeUpdatedAts(freshRows),
  });

  return cascade;
}

/**
 * Clears the in-process cache.  Useful in tests; not intended for production
 * hot paths (the live-reload mechanism handles production invalidation).
 */
export function clearCascadeCache(): void {
  cache.clear();
}

// Re-export for use by editor API and tests.
export { LAYER_ORDER };
