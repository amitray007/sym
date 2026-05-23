import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { encryptedText } from '../columns/encrypted-text.js';
import { uuidv7 } from '../uuid.js';
import { createdAt, tstz, updatedAt } from './_shared.js';
import { workspaces } from './workspaces.js';

export const oauthTokenStatusEnum = pgEnum('oauth_token_status', ['active', 'revoked']);

/** User-owned third-party provider tokens (NOT the Slack bot token, NOT Clerk). */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slackUserId: text('slack_user_id').notNull(),
    provider: text('provider').notNull(),
    accessToken: encryptedText('access_token').notNull(),
    refreshToken: encryptedText('refresh_token'),
    expiresAt: tstz('expires_at'),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    accountHandle: text('account_handle'),
    status: oauthTokenStatusEnum('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    // One active token per (user, provider).
    uniqueIndex('oauth_tokens_one_active_per_user_provider')
      .on(t.workspaceId, t.slackUserId, t.provider)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * Cross-user authorization: grantor A lets grantee B act through A's token for
 * a provider. Non-transitive (enforced in code); scopes ⊆ grantor's token
 * scopes (enforced in code at creation). Default TTL 24h, max 7d.
 */
export const grants = pgTable(
  'grants',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    grantorSlackUserId: text('grantor_slack_user_id').notNull(),
    granteeSlackUserId: text('grantee_slack_user_id').notNull(),
    provider: text('provider').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    revokedBySlackUserId: text('revoked_by_slack_user_id'),
  },
  (t) => [
    // Grant lookup at tool-call time.
    index('grants_lookup')
      .on(t.workspaceId, t.granteeSlackUserId, t.provider, t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
