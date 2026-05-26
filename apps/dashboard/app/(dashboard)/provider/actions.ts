'use server';

import { providerConfigs, uuidv7, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { ensureSecrets } from '@/lib/ensure-secrets';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

async function requireAdmin(): Promise<boolean> {
  return (await dashboardGate()) === 'ok';
}

async function resolveWorkspace(): Promise<{
  db: ReturnType<typeof getDb>;
  id: string;
} | null> {
  const handle = getDb();
  if (!handle) return null;
  const ws = (await handle.db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];
  if (!ws) return null;
  return { db: handle, id: ws.id };
}

/**
 * Save the Fireworks provider config.
 *
 * On update: if `apiKey` is blank, the existing encrypted key is preserved
 * (the column is omitted from `.set()`). Only required on first insert.
 * `modelToneRewrite` and `modelSummarization` are kept equal to `modelChat`
 * (those features are parked; the NOT NULL columns must stay valid).
 */
export async function saveProvider(formData: FormData): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };

  const ctx = await resolveWorkspace();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const modelChat = String(formData.get('modelChat') ?? '').trim();
  const baseUrl = String(formData.get('baseUrl') ?? '').trim() || null;
  const enabled = formData.get('enabled') === 'on';

  if (!modelChat) return { ok: false, error: 'Chat model is required.' };

  const { db } = ctx.db;

  const existing = (
    await db
      .select({ id: providerConfigs.id })
      .from(providerConfigs)
      .where(
        and(eq(providerConfigs.workspaceId, ctx.id), eq(providerConfigs.provider, 'fireworks')),
      )
      .limit(1)
  )[0];

  if (existing) {
    // Update — apiKey is optional; omit from SET when blank to preserve the stored value.
    const baseSet = {
      modelChat,
      modelToneRewrite: modelChat,
      modelSummarization: modelChat,
      baseUrl,
      enabled,
      updatedAt: new Date(),
    };

    if (apiKey) {
      await ensureSecrets();
      await db
        .update(providerConfigs)
        .set({ ...baseSet, apiKey })
        .where(eq(providerConfigs.id, existing.id));
    } else {
      await db.update(providerConfigs).set(baseSet).where(eq(providerConfigs.id, existing.id));
    }
  } else {
    // Insert — apiKey is required on first save.
    if (!apiKey) return { ok: false, error: 'API key is required for a new provider config.' };
    await ensureSecrets();
    await db.insert(providerConfigs).values({
      id: uuidv7(),
      workspaceId: ctx.id,
      provider: 'fireworks',
      apiKey,
      modelChat,
      modelToneRewrite: modelChat,
      modelSummarization: modelChat,
      baseUrl,
      enabled,
    });
  }

  revalidatePath('/provider');
  return { ok: true };
}
