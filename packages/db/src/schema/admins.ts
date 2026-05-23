import { sql } from 'drizzle-orm';
import { type AnyPgColumn, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { uuidv7 } from '../uuid.js';
import { createdAt, tstz } from './_shared.js';
import { workspaces } from './workspaces.js';

export const adminRoleEnum = pgEnum('admin_role', ['owner', 'admin']);

/**
 * Clerk-user ↔ Sym-admin role mapping. Authoritative source of admin status
 * (D-DB-2); Clerk Organizations are optional UI sugar layered on later. This
 * is NOT a sessions table — Clerk owns sessions (no `admin_sessions`).
 *
 * Bootstrap: the user who completes the first Slack OAuth via the Dashboard
 * becomes `owner`; further admins are added by existing admins.
 */
export const dashboardAdmins = pgTable(
  'dashboard_admins',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    clerkUserId: text('clerk_user_id').notNull(),
    email: text('email').notNull(),
    role: adminRoleEnum('role').notNull().default('admin'),
    createdAt: createdAt(),
    createdByAdminId: text('created_by_admin_id').references(
      (): AnyPgColumn => dashboardAdmins.id,
      { onDelete: 'set null' },
    ),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    uniqueIndex('dashboard_admins_ws_clerk_user').on(t.workspaceId, t.clerkUserId),
    // At most one owner per workspace.
    uniqueIndex('dashboard_admins_one_owner_per_ws')
      .on(t.workspaceId)
      .where(sql`${t.role} = 'owner'`),
  ],
);
