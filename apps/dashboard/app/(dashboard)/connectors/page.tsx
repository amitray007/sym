import { mcpConfigs, oauthTokens, workspaces } from '@sym/db';
import { and, asc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';

import { ConnectorForm } from './connector-form';

import type { ConnectorRow, OAuthStatus } from './connector-form';
import type { ConnectorOAuthConfig } from '@sym/contracts';

export const metadata = { title: 'Connectors · Sym' };

export const dynamic = 'force-dynamic';

async function loadConnectors(): Promise<{
  connectors: ConnectorRow[];
  agentUrl: string | null;
}> {
  const agentUrl = process.env.AGENT_URL ?? null;
  const handle = getDb();
  if (!handle) return { connectors: [], agentUrl };

  try {
    const ws = (
      await handle.db
        .select({ id: workspaces.id, ownerSlackUserId: workspaces.ownerSlackUserId })
        .from(workspaces)
        .limit(1)
    )[0];
    if (!ws) return { connectors: [], agentUrl };

    // Fetch all connector rows (never select envJson — keep secrets server-only).
    const rows = await handle.db
      .select({
        id: mcpConfigs.id,
        name: mcpConfigs.name,
        slug: mcpConfigs.slug,
        url: mcpConfigs.url,
        authMode: mcpConfigs.authMode,
        enabled: mcpConfigs.enabled,
        oauthConfigJson: mcpConfigs.oauthConfigJson,
        // Derive hasExistingSecret from envJson presence without exposing the value.
        envJson: mcpConfigs.envJson,
      })
      .from(mcpConfigs)
      .where(eq(mcpConfigs.workspaceId, ws.id))
      .orderBy(asc(mcpConfigs.createdAt));

    // Fetch active OAuth tokens for the workspace owner so we can show connection status.
    // Only query if the owner is set; no sensitive token values are selected.
    const activeTokenMap = new Map<
      string,
      { accountHandle: string | null; expiresAt: Date | null }
    >();
    if (ws.ownerSlackUserId) {
      const tokens = await handle.db
        .select({
          provider: oauthTokens.provider,
          accountHandle: oauthTokens.accountHandle,
          expiresAt: oauthTokens.expiresAt,
        })
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.workspaceId, ws.id),
            eq(oauthTokens.slackUserId, ws.ownerSlackUserId),
            eq(oauthTokens.status, 'active'),
          ),
        );
      for (const t of tokens) {
        activeTokenMap.set(t.provider, {
          accountHandle: t.accountHandle,
          expiresAt: t.expiresAt,
        });
      }
    }

    const connectors: ConnectorRow[] = rows.map((row) => {
      const isOauth = row.authMode === 'oauth';
      const oauthCfg = isOauth ? (row.oauthConfigJson as ConnectorOAuthConfig | null) : null;

      let oauthStatus: OAuthStatus | null = null;
      if (isOauth) {
        const token = activeTokenMap.get(row.slug);
        oauthStatus = token
          ? { connected: true, accountHandle: token.accountHandle, expiresAt: token.expiresAt }
          : { connected: false };
      }

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        url: row.url,
        authMode: row.authMode,
        enabled: row.enabled,
        oauthConfig: oauthCfg
          ? {
              authorizeUrl: oauthCfg.authorizeUrl,
              tokenUrl: oauthCfg.tokenUrl,
              clientId: oauthCfg.clientId,
              scopes: oauthCfg.scopes,
            }
          : null,
        // hasExistingSecret: true if envJson is a non-empty string (encrypted value present).
        hasExistingSecret: typeof row.envJson === 'string' && row.envJson.length > 0,
        oauthStatus,
      };
    });

    return { connectors, agentUrl };
  } catch {
    return { connectors: [], agentUrl };
  }
}

export default async function ConnectorsPage() {
  const gate = await dashboardGate();
  if (gate === 'sign-in') redirect('/sign-in');
  if (gate === 'request-access') redirect('/request-access');

  const { connectors, agentUrl } = await loadConnectors();

  return <ConnectorForm connectors={connectors} agentUrl={agentUrl} />;
}
