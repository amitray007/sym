import { mcpConfigs, workspaces } from '@sym/db';
import { asc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';

import { McpForm } from './mcp-form';

import type { McpConfigRow } from './mcp-form';

export const metadata = { title: 'MCP Servers · Sym' };

export const dynamic = 'force-dynamic';

async function loadMcpConfigs(): Promise<McpConfigRow[]> {
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
        enabled: mcpConfigs.enabled,
      })
      .from(mcpConfigs)
      .where(eq(mcpConfigs.workspaceId, ws.id))
      .orderBy(asc(mcpConfigs.createdAt));
  } catch {
    return [];
  }
}

export default async function McpPage() {
  const gate = await dashboardGate();
  if (gate === 'sign-in') redirect('/sign-in');
  if (gate === 'request-access') redirect('/request-access');

  const configs = await loadMcpConfigs();

  return <McpForm configs={configs} />;
}
