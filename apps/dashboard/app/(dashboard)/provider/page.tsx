import { providerConfigs, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';

import { ProviderForm } from './provider-form';

import type { ProviderFormProps } from './provider-form';

export const metadata = { title: 'Provider · Sym' };

export const dynamic = 'force-dynamic';

async function loadProviderConfig(): Promise<ProviderFormProps> {
  const handle = getDb();
  if (!handle) {
    return { modelChat: null, baseUrl: null, enabled: true, hasKey: false, updatedAt: null };
  }

  try {
    const ws = (await handle.db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];
    if (!ws) {
      return { modelChat: null, baseUrl: null, enabled: true, hasKey: false, updatedAt: null };
    }

    const row = (
      await handle.db
        .select({
          modelChat: providerConfigs.modelChat,
          baseUrl: providerConfigs.baseUrl,
          enabled: providerConfigs.enabled,
          updatedAt: providerConfigs.updatedAt,
          // apiKey is an encryptedText column — selecting it decrypts it server-side.
          // We only want to know if a key exists; derive `hasKey` without returning the value.
          apiKey: providerConfigs.apiKey,
        })
        .from(providerConfigs)
        .where(
          and(eq(providerConfigs.workspaceId, ws.id), eq(providerConfigs.provider, 'fireworks')),
        )
        .limit(1)
    )[0];

    if (!row) {
      return { modelChat: null, baseUrl: null, enabled: true, hasKey: false, updatedAt: null };
    }

    return {
      modelChat: row.modelChat,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      // Derive hasKey: the column is NOT NULL but may be an empty string if something went wrong.
      // A non-empty decrypted value means a real key is stored.
      hasKey: typeof row.apiKey === 'string' && row.apiKey.length > 0,
      updatedAt: row.updatedAt,
    };
  } catch {
    return { modelChat: null, baseUrl: null, enabled: true, hasKey: false, updatedAt: null };
  }
}

export default async function ProviderPage() {
  const gate = await dashboardGate();
  if (gate === 'sign-in') redirect('/sign-in');
  if (gate === 'request-access') redirect('/request-access');

  const config = await loadProviderConfig();

  return <ProviderForm {...config} />;
}
