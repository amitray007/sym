'use server';

import { dashboardAdmins, mcpConfigs, oauthTokens, uuidv7, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { authMode, dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { ensureSecrets } from '@/lib/ensure-secrets';

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

  // OAuth fields
  const authorizeUrl = String(formData.get('authorizeUrl') ?? '').trim();
  const tokenUrl = String(formData.get('tokenUrl') ?? '').trim();
  const clientId = String(formData.get('clientId') ?? '').trim();
  const scopesRaw = String(formData.get('scopes') ?? '').trim();
  const clientSecret = String(formData.get('clientSecret') ?? '').trim();

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

  if (resolvedAuthMode === 'oauth') {
    if (!authorizeUrl) return { ok: false, error: 'Authorize URL is required for OAuth mode.' };
    if (!tokenUrl) return { ok: false, error: 'Token URL is required for OAuth mode.' };
    if (!clientId) return { ok: false, error: 'Client ID is required for OAuth mode.' };
    if (!clientSecret) return { ok: false, error: 'Client secret is required for OAuth mode.' };
  }

  if (await isSlugTaken(ctx.db, ctx.workspaceId, slug)) {
    return {
      ok: false,
      error: `A connector with slug "${slug}" already exists in this workspace.`,
    };
  }

  const adminId = await resolveActingAdminId(ctx.workspaceId);

  // Build envJson and oauthConfigJson based on auth mode.
  let envJson: string | null = null;
  let oauthConfigJson: unknown = null;

  if (resolvedAuthMode === 'static' && token) {
    // envJson is an encryptedText column — pass the JSON string; encryption is automatic.
    await ensureSecrets();
    envJson = JSON.stringify({ token });
  } else if (resolvedAuthMode === 'oauth') {
    // The client secret goes into envJson (encrypted); public config into oauthConfigJson (jsonb).
    const scopes = scopesRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    oauthConfigJson = { authorizeUrl, tokenUrl, clientId, scopes };
    await ensureSecrets();
    envJson = JSON.stringify({ clientSecret });
  }

  await ctx.db.db.insert(mcpConfigs).values({
    id: uuidv7(),
    workspaceId: ctx.workspaceId,
    name,
    slug,
    transport: 'http',
    url,
    authMode: resolvedAuthMode,
    envJson,
    oauthConfigJson,
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

  // OAuth fields
  const authorizeUrl = String(formData.get('authorizeUrl') ?? '').trim();
  const tokenUrl = String(formData.get('tokenUrl') ?? '').trim();
  const clientId = String(formData.get('clientId') ?? '').trim();
  const scopesRaw = String(formData.get('scopes') ?? '').trim();
  const clientSecret = String(formData.get('clientSecret') ?? '').trim();

  if (!name) return { ok: false, error: 'Name is required.' };
  const slugErr = validateSlug(slug);
  if (slugErr) return { ok: false, error: slugErr };
  const urlErr = validateUrl(url);
  if (urlErr) return { ok: false, error: urlErr };

  const resolvedAuthMode = validateAuthMode(authModeRaw);
  if (!resolvedAuthMode) return { ok: false, error: 'Invalid auth mode.' };

  if (resolvedAuthMode === 'oauth') {
    if (!authorizeUrl) return { ok: false, error: 'Authorize URL is required for OAuth mode.' };
    if (!tokenUrl) return { ok: false, error: 'Token URL is required for OAuth mode.' };
    if (!clientId) return { ok: false, error: 'Client ID is required for OAuth mode.' };
  }

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

  // Determine envJson and oauthConfigJson update strategy.
  // - static: if new token provided → encrypt fresh; if blank → keep existing (omit column).
  // - oauth: if new clientSecret provided → encrypt fresh; if blank → keep existing (omit column).
  //          oauthConfigJson is always updated from the public fields.
  // - none: clear both.
  let envJson: string | null | undefined;
  let oauthConfigJson: unknown | undefined;

  if (resolvedAuthMode === 'static') {
    if (token) {
      await ensureSecrets();
      envJson = JSON.stringify({ token });
    } else {
      // Blank = keep existing secret. Pass undefined so Drizzle omits the column from SET.
      envJson = undefined;
    }
    // Clear any stale oauth config.
    oauthConfigJson = null;
  } else if (resolvedAuthMode === 'oauth') {
    const scopes = scopesRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Public config always updated.
    oauthConfigJson = { authorizeUrl, tokenUrl, clientId, scopes };
    if (clientSecret) {
      // New secret provided — encrypt fresh.
      await ensureSecrets();
      envJson = JSON.stringify({ clientSecret });
    } else {
      // Blank = keep existing encrypted secret. Omit from SET.
      envJson = undefined;
    }
  } else {
    // Switched to none — clear both stored secret and oauth config.
    envJson = null;
    oauthConfigJson = null;
  }

  // Build the update set conditionally to avoid overwriting envJson when unchanged.
  // oauthConfigJson is a plain jsonb column so undefined means "omit from SET".
  const baseSet = {
    name,
    slug,
    url,
    authMode: resolvedAuthMode,
    updatedAt: new Date(),
    updatedByAdminId: adminId,
    ...(oauthConfigJson !== undefined ? { oauthConfigJson } : {}),
  };

  const setValues = envJson !== undefined ? { ...baseSet, envJson } : baseSet;

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

/**
 * Revoke the workspace owner's active OAuth token for a connector.
 * The connector config (mcpConfigs row) is preserved; only the per-user
 * credential is revoked so the owner can re-connect at any time.
 */
export async function disconnectConnector(slug: string): Promise<ActionResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'Forbidden.' };
  const ctx = await resolveContext();
  if (!ctx?.db) return { ok: false, error: 'Workspace not installed yet.' };

  // Resolve the workspace owner so we revoke the correct token.
  const ws = (
    await ctx.db.db
      .select({ ownerSlackUserId: workspaces.ownerSlackUserId })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1)
  )[0];

  if (!ws?.ownerSlackUserId) {
    return { ok: false, error: 'Workspace owner not set.' };
  }

  // Mark the active token as revoked. The unique partial index
  // (workspaceId, slackUserId, provider) WHERE status='active' ensures at most one.
  await ctx.db.db
    .update(oauthTokens)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(oauthTokens.workspaceId, ctx.workspaceId),
        eq(oauthTokens.slackUserId, ws.ownerSlackUserId),
        eq(oauthTokens.provider, slug),
        eq(oauthTokens.status, 'active'),
      ),
    );

  revalidatePath('/connectors');
  return { ok: true };
}
