'use server';

import { aclModes, providerConfigs, uuidv7, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { isAdmin } from '@/lib/admin-check';
import { getDb } from '@/lib/db';
import { ensureSecrets } from '@/lib/ensure-secrets';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Server actions are a public surface — gate every mutation on admin, not just
 * the UI. Without Clerk keys (dev) there's no auth, so allow. Fails closed
 * (denies) when the admin check can't be satisfied.
 */
async function requireAdmin(): Promise<boolean> {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return true;
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (!userId) return false;
  return isAdmin(userId);
}

async function workspaceId(): Promise<{ db: ReturnType<typeof getDb>; id: string } | null> {
  const handle = getDb();
  if (!handle) return null;
  const ws = (await handle.db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];
  if (!ws) return null;
  return { db: handle, id: ws.id };
}

/** Save the Fireworks provider config. The API key is encrypted at rest. */
export async function saveProviderConfig(formData: FormData): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };
  const ctx = await workspaceId();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const modelChat = String(formData.get('modelChat') ?? '').trim();
  const modelToneRewrite = String(formData.get('modelToneRewrite') ?? '').trim();
  const modelSummarization = String(formData.get('modelSummarization') ?? '').trim();
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();

  if (!apiKey) return { ok: false, error: 'API key is required.' };
  if (!modelChat || !modelToneRewrite || !modelSummarization) {
    return { ok: false, error: 'All three model fields are required.' };
  }

  await ensureSecrets(); // so the encryptedText column encrypts the key
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

  const values = {
    apiKey,
    modelChat,
    modelToneRewrite,
    modelSummarization,
    enabled: true,
    updatedAt: new Date(),
    ...(baseUrl ? { baseUrl } : { baseUrl: null }),
  };

  if (existing) {
    await db.update(providerConfigs).set(values).where(eq(providerConfigs.id, existing.id));
  } else {
    await db.insert(providerConfigs).values({
      id: uuidv7(),
      workspaceId: ctx.id,
      provider: 'fireworks',
      ...values,
    });
  }

  revalidatePath('/setup');
  return { ok: true };
}

/** Save the Slack-surface ACL mode (minimal first-run editor). */
export async function saveAcl(formData: FormData): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };
  const ctx = await workspaceId();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  type AclMode = 'open' | 'allowlist' | 'workspace_minus_blocked';
  const validModes: AclMode[] = ['open', 'allowlist', 'workspace_minus_blocked'];
  const raw = String(formData.get('slackMode') ?? 'open');
  if (!validModes.includes(raw as AclMode)) {
    return { ok: false, error: 'Invalid ACL mode.' };
  }
  const mode = raw as AclMode;
  const { db } = ctx.db;

  await db
    .insert(aclModes)
    .values({ workspaceId: ctx.id, surface: 'slack', mode })
    .onConflictDoUpdate({
      target: [aclModes.workspaceId, aclModes.surface],
      set: { mode, updatedAt: new Date() },
    });

  revalidatePath('/setup');
  return { ok: true };
}
