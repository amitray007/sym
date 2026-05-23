import { pgEnum, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { uuidv7 } from '../uuid.js';
import { updatedAt } from './_shared.js';
import { dashboardAdmins } from './admins.js';
import { workspaces } from './workspaces.js';

export const aclSurfaceEnum = pgEnum('acl_surface', ['slack', 'dashboard']);

export const aclModeEnum = pgEnum('acl_mode', ['open', 'allowlist', 'workspace_minus_blocked']);

export const aclUserStatusEnum = pgEnum('acl_user_status', ['allow', 'block']);

/**
 * Per-surface ACL mode. One row per (workspace, surface). Default on
 * workspace creation: slack=open, dashboard=allowlist. The invariant
 * "dashboard access ⊆ slack access" is enforced in the app layer.
 */
export const aclModes = pgTable(
  'acl_modes',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    surface: aclSurfaceEnum('surface').notNull(),
    mode: aclModeEnum('mode').notNull(),
    updatedAt: updatedAt(),
    updatedByAdminId: text('updated_by_admin_id').references(() => dashboardAdmins.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.surface] })],
);

/** Per-user allow/block, per surface. Interacts with the surface's mode. */
export const aclUserRules = pgTable(
  'acl_user_rules',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    surface: aclSurfaceEnum('surface').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    status: aclUserStatusEnum('status').notNull(),
    updatedAt: updatedAt(),
    updatedByAdminId: text('updated_by_admin_id').references(() => dashboardAdmins.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('acl_user_rules_ws_surface_user').on(t.workspaceId, t.surface, t.slackUserId),
  ],
);
