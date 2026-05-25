import { mcpConfigs, workspaces } from '@sym/db';
import { asc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';

import { ConnectorForm } from './connector-form';

import type { ConnectorRow } from './connector-form';

export const metadata = { title: 'Connectors · Sym' };

export const dynamic = 'force-dynamic';

async function loadConnectors(): Promise<ConnectorRow[]> {
  const handle = getDb();
  if (!handle) return [];

  try {
    const ws = (await handle.db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];
    if (!ws) return [];

    return await handle.db
      .select({
        id: mcpConfigs.id,
        name: mcpConfigs.name,
        slug: mcpConfigs.slug,
        url: mcpConfigs.url,
        authMode: mcpConfigs.authMode,
        enabled: mcpConfigs.enabled,
      })
      .from(mcpConfigs)
      .where(eq(mcpConfigs.workspaceId, ws.id))
      .orderBy(asc(mcpConfigs.createdAt));
  } catch {
    return [];
  }
}

export default async function ConnectorsPage() {
  const gate = await dashboardGate();
  if (gate === 'sign-in') redirect('/sign-in');
  if (gate === 'request-access') redirect('/request-access');

  const connectors = await loadConnectors();

  return <ConnectorForm connectors={connectors} />;
}
