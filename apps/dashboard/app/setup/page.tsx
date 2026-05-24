import { providerConfigs, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { isAdmin, getWorkspace } from '@/lib/admin-check';
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
  // Admin gate — /setup lives outside the (dashboard) group, so gate it here too.
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    if (!userId) redirect('/sign-in');
    if (!(await isAdmin(userId))) redirect('/request-access');
  }

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
