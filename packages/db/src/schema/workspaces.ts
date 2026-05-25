import { sql } from 'drizzle-orm';
import { type AnyPgColumn, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { encryptedText } from '../columns/encrypted-text.js';
import { uuidv7 } from '../uuid.js';
import { createdAt, tstz, updatedAt } from './_shared.js';
import { dashboardAdmins } from './admins.js';

export const workspaceStatusEnum = pgEnum('workspace_status', ['active', 'suspended']);

export const slackInstallStatusEnum = pgEnum('slack_install_status', ['active', 'revoked']);

/** The Sym install itself. Single row in practice (single-tenant per install). */
export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey().$defaultFn(uuidv7),
  slackTeamId: text('slack_team_id').notNull().unique(),
  name: text('name').notNull(),
  /**
   * The single human this Sym works for — the Slack user who first installed it
   * (captured from OAuth `authed_user.id`). Set once on first install, never
   * overwritten on re-auth. Nullable only so the backfill migration can run; the
   * agent's owner gate fails closed (ignores every turn) if it's ever null.
   * Source of truth for "Sym acts only on the owner's requests".
   */
  ownerSlackUserId: text('owner_slack_user_id'),
  timezone: text('timezone'),
  status: workspaceStatusEnum('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The Slack bot install: bot token, scopes, install actor. Separate from
 * `workspaces` because installs can be re-done (re-auth, scope upgrade) and
 * we keep history — re-installing inserts a new row and marks the old revoked.
 */
export const slackInstalls = pgTable(
  'slack_installs',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    botUserId: text('bot_user_id').notNull(),
    appId: text('app_id').notNull(),
    botAccessToken: encryptedText('bot_access_token').notNull(),
    scopes: text('scopes').array().notNull(),
    enterpriseId: text('enterprise_id'),
    installedBySlackUserId: text('installed_by_slack_user_id').notNull(),
    installedByAdminId: text('installed_by_admin_id').references(
      (): AnyPgColumn => dashboardAdmins.id,
      { onDelete: 'set null' },
    ),
    rawInstallPayload: encryptedText('raw_install_payload'),
    status: slackInstallStatusEnum('status').notNull().default('active'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // One active install per workspace (partial unique).
    uniqueIndex('slack_installs_one_active_per_ws')
      .on(t.workspaceId)
      .where(sql`${t.status} = 'active'`),
  ],
);
