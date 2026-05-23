import { sql } from 'drizzle-orm';
import { boolean, check, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { uuidv7 } from '../uuid.js';
import { createdAt, updatedAt } from './_shared.js';
import { dashboardAdmins } from './admins.js';
import { workspaces } from './workspaces.js';

export const soulLayerEnum = pgEnum('soul_layer', ['l1_workspace', 'l2_channel', 'l3_user']);

/**
 * L1/L2/L3 soul rows; L0 (`sym.soul.md`) is hardcoded and never persisted.
 * Cascade resolves most-specific over least-specific. Live-reload via
 * `updated_at` invalidation in the runtime cache — no restart needed.
 *
 * `scope_id`: NULL for l1_workspace; slack_channel_id for l2_channel;
 * slack_user_id for l3_user.
 */
export const soulLayers = pgTable(
  'soul_layers',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    layer: soulLayerEnum('layer').notNull(),
    scopeId: text('scope_id'),
    contentMd: text('content_md').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedByAdminId: text('updated_by_admin_id').references(() => dashboardAdmins.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    // At most one row per (layer, scope_id). NULLs are distinct in PG, so the
    // single l1_workspace row is enforced by a separate partial unique.
    uniqueIndex('soul_layers_ws_layer_scope').on(t.workspaceId, t.layer, t.scopeId),
    uniqueIndex('soul_layers_one_l1_per_ws')
      .on(t.workspaceId)
      .where(sql`${t.layer} = 'l1_workspace'`),
    check(
      'soul_layers_scope_shape',
      sql`(${t.layer} = 'l1_workspace' AND ${t.scopeId} IS NULL) OR (${t.layer} IN ('l2_channel','l3_user') AND ${t.scopeId} IS NOT NULL)`,
    ),
  ],
);
