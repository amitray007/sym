'use server';

import { dashboardAdmins, mcpConfigs, uuidv7, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { authMode, dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const VALID_AUTH_MODES = ['none', 'static', 'oauth'] as const;
type ConnectorAuthMode = (typeof VALID_AUTH_MODES)[number];

/**
 * Server actions are a public surface — gate every mutation, not just the UI.
 * dashboardGate handles all modes (password session / Clerk admin / open dev);
 * only 'ok' may write. Fails closed.
 */
async function requireAdmin(): Promise<boolean> {
  return (await dashboardGate()) === 'ok';
}

async function resolveContext(): Promise<{
  db: ReturnType<typeof getDb>;
  workspaceId: string;
} | null> {
  const handle = getDb();
  if (!handle) return null;
  const ws = (await handle.db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];
  if (!ws) return null;
  return { db: handle, workspaceId: ws.id };
}

/**
 * Resolve the acting admin's row ID for audit columns (updatedByAdminId).
 * Only available in Clerk mode (password mode has no per-user identity).
 * Returns null in password / open mode — callers pass null to the column.
 */
async function resolveActingAdminId(workspaceId: string): Promise<string | null> {
  if (authMode() !== 'clerk') return null;
  const handle = getDb();
  if (!handle) return null;
  try {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    if (!userId) return null;
    const row = (
      await handle.db
        .select({ id: dashboardAdmins.id })
        .from(dashboardAdmins)
        .where(
          and(
            eq(dashboardAdmins.workspaceId, workspaceId),
            eq(dashboardAdmins.clerkUserId, userId),
          ),
        )
        .limit(1)
    )[0];
    return row?.id ?? null;
  } catch {
    return null;
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateSlug(slug: string): string | null {
  if (!slug) return 'Slug is required.';
  if (!SLUG_RE.test(slug))
    return 'Slug must start with a lowercase letter or digit and contain only a–z, 0–9, and hyphens.';
  return null;
}

function validateUrl(url: string): string | null {
  if (!url) return 'URL is required.';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return 'URL must use https.';
    return null;
  } catch {
    return 'URL is not valid.';
  }
}

function validateAuthMode(raw: string): ConnectorAuthMode | null {
  if ((VALID_AUTH_MODES as readonly string[]).includes(raw)) {
    return raw as ConnectorAuthMode;
  }
  return null;
}

/** Check whether a (workspaceId, slug) pair is already taken (excluding a given row id). */
async function isSlugTaken(
  db: NonNullable<ReturnType<typeof getDb>>,
  workspaceId: string,
  slug: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db.db
    .select({ id: mcpConfigs.id })
    .from(mcpConfigs)
    .where(and(eq(mcpConfigs.workspaceId, workspaceId), eq(mcpConfigs.slug, slug)))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (excludeId && row.id === excludeId) return false;
  return true;
}

export async function createConnector(formData: FormData): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };
  const ctx = await resolveContext();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  const url = String(formData.get('url') ?? '').trim();
  const authModeRaw = String(formData.get('authMode') ?? 'none').trim();
  const token = String(formData.get('token') ?? '').trim();

  if (!name) return { ok: false, error: 'Name is required.' };
  const slugErr = validateSlug(slug);
  if (slugErr) return { ok: false, error: slugErr };
  const urlErr = validateUrl(url);
  if (urlErr) return { ok: false, error: urlErr };

  const resolvedAuthMode = validateAuthMode(authModeRaw);
  if (!resolvedAuthMode) return { ok: false, error: 'Invalid auth mode.' };

  if (resolvedAuthMode === 'static' && !token) {
    return { ok: false, error: 'A token is required for Static auth mode.' };
  }

  if (await isSlugTaken(ctx.db, ctx.workspaceId, slug)) {
    return {
      ok: false,
      error: `A connector with slug "${slug}" already exists in this workspace.`,
    };
  }

  const adminId = await resolveActingAdminId(ctx.workspaceId);

  // envJson is an encryptedText column — pass the JSON string; encryption is automatic.
  const envJson = resolvedAuthMode === 'static' && token ? JSON.stringify({ token }) : null;

  await ctx.db.db.insert(mcpConfigs).values({
    id: uuidv7(),
    workspaceId: ctx.workspaceId,
    name,
    slug,
    transport: 'http',
    url,
    authMode: resolvedAuthMode,
    envJson,
    enabled: true,
    updatedByAdminId: adminId,
  });

  revalidatePath('/connectors');
  return { ok: true };
}

export async function updateConnector(id: string, formData: FormData): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };
  const ctx = await resolveContext();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  const url = String(formData.get('url') ?? '').trim();
  const authModeRaw = String(formData.get('authMode') ?? 'none').trim();
  const token = String(formData.get('token') ?? '').trim();

  if (!name) return { ok: false, error: 'Name is required.' };
  const slugErr = validateSlug(slug);
  if (slugErr) return { ok: false, error: slugErr };
  const urlErr = validateUrl(url);
  if (urlErr) return { ok: false, error: urlErr };

  const resolvedAuthMode = validateAuthMode(authModeRaw);
  if (!resolvedAuthMode) return { ok: false, error: 'Invalid auth mode.' };

  // Confirm the row belongs to this workspace before updating.
  const existing = (
    await ctx.db.db
      .select({ id: mcpConfigs.id, authMode: mcpConfigs.authMode, envJson: mcpConfigs.envJson })
      .from(mcpConfigs)
      .where(and(eq(mcpConfigs.id, id), eq(mcpConfigs.workspaceId, ctx.workspaceId)))
      .limit(1)
  )[0];
  if (!existing) return { ok: false, error: 'Connector not found.' };

  if (await isSlugTaken(ctx.db, ctx.workspaceId, slug, id)) {
    return {
      ok: false,
      error: `A connector with slug "${slug}" already exists in this workspace.`,
    };
  }

  const adminId = await resolveActingAdminId(ctx.workspaceId);

  // For static mode: if no new token is provided, keep the existing envJson.
  // If switching away from static, clear envJson.
  let envJson: string | null | undefined;
  if (resolvedAuthMode === 'static') {
    if (token) {
      // New token provided — encrypt fresh.
      envJson = JSON.stringify({ token });
    } else {
      // Blank token = keep existing. Pass undefined so Drizzle omits the column from SET.
      envJson = undefined;
    }
  } else {
    // Switched to none/oauth — clear any stored token.
    envJson = null;
  }

  // Build the update set conditionally to avoid overwriting envJson when unchanged.
  const setValues =
    envJson !== undefined
      ? {
          name,
          slug,
          url,
          authMode: resolvedAuthMode,
          envJson,
          updatedAt: new Date(),
          updatedByAdminId: adminId,
        }
      : {
          name,
          slug,
          url,
          authMode: resolvedAuthMode,
          updatedAt: new Date(),
          updatedByAdminId: adminId,
        };

  await ctx.db.db.update(mcpConfigs).set(setValues).where(eq(mcpConfigs.id, id));

  revalidatePath('/connectors');
  return { ok: true };
}

export async function deleteConnector(id: string): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };
  const ctx = await resolveContext();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  // Confirm the row belongs to this workspace before deleting.
  const existing = (
    await ctx.db.db
      .select({ id: mcpConfigs.id })
      .from(mcpConfigs)
      .where(and(eq(mcpConfigs.id, id), eq(mcpConfigs.workspaceId, ctx.workspaceId)))
      .limit(1)
  )[0];
  if (!existing) return { ok: false, error: 'Connector not found.' };

  await ctx.db.db.delete(mcpConfigs).where(eq(mcpConfigs.id, id));

  revalidatePath('/connectors');
  return { ok: true };
}

export async function setConnectorEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };
  const ctx = await resolveContext();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  // Confirm the row belongs to this workspace before toggling.
  const existing = (
    await ctx.db.db
      .select({ id: mcpConfigs.id })
      .from(mcpConfigs)
      .where(and(eq(mcpConfigs.id, id), eq(mcpConfigs.workspaceId, ctx.workspaceId)))
      .limit(1)
  )[0];
  if (!existing) return { ok: false, error: 'Connector not found.' };

  const adminId = await resolveActingAdminId(ctx.workspaceId);

  await ctx.db.db
    .update(mcpConfigs)
    .set({ enabled, updatedAt: new Date(), updatedByAdminId: adminId })
    .where(eq(mcpConfigs.id, id));

  revalidatePath('/connectors');
  return { ok: true };
}
