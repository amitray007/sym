import { mcpConfigs, oauthTokens } from '@sym/db';
import { and, eq } from 'drizzle-orm';

import { refreshConnectorToken } from './connector-oauth.js';

import type { ConnectorOAuthConfig, SlackUserId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

/** Result of resolving a connector's auth for a given requester. */
export type ConnectorAuth =
  /** Open server, no header needed. */
  | { kind: 'none' }
  /** Ready Bearer header value. */
  | { kind: 'token'; authorization: string }
  /** OAuth mode and the user has not connected (or token is expired with no refresh). */
  | { kind: 'needs_auth' }
  /** No enabled connector row found for the given (workspaceId, slug). */
  | { kind: 'unknown' };

export interface ResolveConnectorAuthParams {
  db: Database;
  workspaceId: WorkspaceId;
  /** The connector's slug (= the oauth_tokens.provider key). */
  slug: string;
  requester: SlackUserId;
}

/**
 * Parse `envJson` from an mcp_configs row.
 * The column is `encryptedText` which auto-decrypts on read, so `raw` is
 * already plaintext (or null). Returns `{}` on any parse failure.
 */
function parseEnvJson(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Resolve the authentication descriptor for a connector MCP server call.
 *
 * - `none`      → open server, no auth header
 * - `token`     → `authorization` is a ready `Bearer …` string
 * - `needs_auth` → connector exists but the user must complete OAuth (or the
 *                  static token is misconfigured)
 * - `unknown`   → no enabled connector row for (workspaceId, slug)
 */
export async function resolveConnectorAuth(p: ResolveConnectorAuthParams): Promise<ConnectorAuth> {
  const { db, workspaceId, slug, requester } = p;

  // Load the connector row.
  const connectorRows = await db
    .select()
    .from(mcpConfigs)
    .where(
      and(
        eq(mcpConfigs.workspaceId, workspaceId),
        eq(mcpConfigs.slug, slug),
        eq(mcpConfigs.enabled, true),
      ),
    )
    .limit(1);

  const connector = connectorRows[0];
  if (connector === undefined) {
    return { kind: 'unknown' };
  }

  const { authMode } = connector;

  if (authMode === 'none') {
    return { kind: 'none' };
  }

  if (authMode === 'static') {
    const env = parseEnvJson(connector.envJson);
    const token = env['token'];
    if (typeof token === 'string' && token.length > 0) {
      return { kind: 'token', authorization: `Bearer ${token}` };
    }
    return { kind: 'needs_auth' };
  }

  // authMode === 'oauth'
  const tokenRows = await db
    .select()
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.workspaceId, workspaceId),
        eq(oauthTokens.slackUserId, requester),
        eq(oauthTokens.provider, slug),
        eq(oauthTokens.status, 'active'),
      ),
    )
    .limit(1);

  const tokenRow = tokenRows[0];
  if (tokenRow === undefined) {
    return { kind: 'needs_auth' };
  }

  const now = new Date();
  const expired =
    tokenRow.expiresAt !== null && tokenRow.expiresAt !== undefined && tokenRow.expiresAt <= now;

  if (expired) {
    // Attempt refresh-on-read if we have all the pieces.
    const refreshed = await attemptTokenRefresh({
      db,
      workspaceId,
      slug,
      requester,
      connector,
      tokenRow,
    });
    return refreshed;
  }

  return { kind: 'token', authorization: `Bearer ${tokenRow.accessToken}` };
}

// ---------------------------------------------------------------------------
// Internal: refresh-on-read helper
// ---------------------------------------------------------------------------

/**
 * Attempt to refresh an expired OAuth token using the stored refreshToken.
 * Returns the new `token` auth if successful, `needs_auth` on any failure.
 * Never throws — the turn path must stay clean.
 */
async function attemptTokenRefresh(p: {
  db: Database;
  workspaceId: WorkspaceId;
  slug: string;
  requester: SlackUserId;
  connector: {
    oauthConfigJson: unknown;
    envJson: string | null;
  };
  tokenRow: {
    id: string;
    refreshToken: string | null;
    accessToken: string;
  };
}): Promise<ConnectorAuth> {
  const { db, workspaceId, slug, requester, connector, tokenRow } = p;

  try {
    // Need a refreshToken to attempt refresh.
    if (!tokenRow.refreshToken) {
      return { kind: 'needs_auth' };
    }

    // Parse the oauthConfigJson to get tokenUrl + clientId.
    if (!connector.oauthConfigJson || typeof connector.oauthConfigJson !== 'object') {
      return { kind: 'needs_auth' };
    }
    const oauthCfg = connector.oauthConfigJson as ConnectorOAuthConfig;
    if (!oauthCfg.tokenUrl || !oauthCfg.clientId) {
      return { kind: 'needs_auth' };
    }

    // Decrypt clientSecret from envJson.
    const env = parseEnvJson(connector.envJson);
    const clientSecret = typeof env['clientSecret'] === 'string' ? env['clientSecret'] : '';

    const refreshed = await refreshConnectorToken({
      tokenUrl: oauthCfg.tokenUrl,
      clientId: oauthCfg.clientId,
      clientSecret,
      refreshToken: tokenRow.refreshToken,
    });

    const newExpiresAt =
      typeof refreshed.expiresIn === 'number'
        ? new Date(Date.now() + refreshed.expiresIn * 1000)
        : null;

    // Update the existing token row in-place.
    await db
      .update(oauthTokens)
      .set({
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken !== undefined ? { refreshToken: refreshed.refreshToken } : {}),
        ...(newExpiresAt !== null ? { expiresAt: newExpiresAt } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(oauthTokens.workspaceId, workspaceId),
          eq(oauthTokens.slackUserId, requester),
          eq(oauthTokens.provider, slug),
          eq(oauthTokens.id, tokenRow.id),
        ),
      );

    return { kind: 'token', authorization: `Bearer ${refreshed.accessToken}` };
  } catch (err) {
    // Refresh failed — require re-auth. Never propagate into the turn path.
    console.warn('[connector-auth] token refresh failed, requiring re-auth:', err);
    return { kind: 'needs_auth' };
  }
}
