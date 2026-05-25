import { providerConfigs, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { getWorkspace } from '@/lib/admin-check';
import { dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getSetupStatus } from '@/lib/setup';

import { SetupWizard } from './setup-wizard';

interface ProviderPrefill {
  modelChat: string;
  modelToneRewrite: string;
  modelSummarization: string;
  baseUrl: string | null;
}

/** Load the existing Fireworks config (for prefill). Never returns the key. */
async function loadProvider(): Promise<ProviderPrefill | null> {
  const handle = getDb();
  if (!handle) return null;
  const { db } = handle;
  const ws = (await db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];
  if (!ws) return null;
  const row = (
    await db
      .select({
        modelChat: providerConfigs.modelChat,
        modelToneRewrite: providerConfigs.modelToneRewrite,
        modelSummarization: providerConfigs.modelSummarization,
        baseUrl: providerConfigs.baseUrl,
      })
      .from(providerConfigs)
      .where(and(eq(providerConfigs.workspaceId, ws.id), eq(providerConfigs.provider, 'fireworks')))
      .limit(1)
  )[0];
  return row ?? null;
}

export default async function SetupPage() {
  // Auth gate — /setup lives outside the (dashboard) group, so gate it here too.
  // In Clerk mode this is bootstrap-aware (allowlisted user promoted to owner on
  // return from install); in password mode a valid session = owner.
  const gate = await dashboardGate();
  if (gate === 'sign-in') redirect('/sign-in');
  if (gate === 'request-access') redirect('/request-access');

  const [status, workspace, provider] = await Promise.all([
    getSetupStatus(),
    getWorkspace(),
    loadProvider(),
  ]);

  return (
    <SetupWizard
      status={status}
      workspaceName={workspace?.name ?? null}
      agentInstallUrl={process.env.AGENT_URL ?? null}
      provider={provider}
    />
  );
}
