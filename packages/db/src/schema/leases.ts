import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';

import { uuidv7 } from '../uuid.js';
import { tstz } from './_shared.js';
import { grants, oauthTokens } from './oauth.js';
import { workspaces } from './workspaces.js';

/**
 * Turn-scoped credential leases for the egress proxy. One per
 * (turn, provider, domain), issued just before sandbox spawn, consumed by the
 * proxy during the turn, purged after expiry. The proxy keeps these hot in
 * memory; Postgres is the (encrypted, in Sp4) backup. The sandbox itself
 * never sees tokens — the proxy injects them by lease.
 */
export const leases = pgTable(
  'leases',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    sandboxJwtId: text('sandbox_jwt_id').notNull().unique(),
    requesterSlackUserId: text('requester_slack_user_id').notNull(),
    provider: text('provider').notNull(),
    domain: text('domain').notNull(),
    oauthTokenId: text('oauth_token_id')
      .notNull()
      .references(() => oauthTokens.id),
    onBehalfOfSlackUserId: text('on_behalf_of_slack_user_id'),
    grantId: text('grant_id').references(() => grants.id),
    issuedAt: tstz('issued_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    useCount: integer('use_count').notNull().default(0),
  },
  (t) => [
    index('leases_expiry').on(t.expiresAt),
    // Proxy lookup for an unconsumed lease.
    index('leases_proxy_lookup')
      .on(t.workspaceId, t.requesterSlackUserId, t.provider, t.domain)
      .where(sql`${t.consumedAt} IS NULL`),
  ],
);
