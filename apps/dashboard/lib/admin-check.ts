/**
 * Server-side admin gate.
 *
 * Checks that the Clerk userId exists in `dashboard_admins` (not revoked)
 * for any workspace. Single-tenant: at most one workspace row exists.
 *
 * Returns false when DB is unreachable (no DATABASE_URL / build-time) —
 * callers treat that as "not admin" and redirect to /request-access.
 */

import { dashboardAdmins, workspaces } from '@sym/db';
import { eq } from 'drizzle-orm';

import { getDb } from './db';

export async function isAdmin(clerkUserId: string): Promise<boolean> {
  const handle = getDb();
  if (!handle) return false;

  try {
    const rows = await handle.db
      .select({ id: dashboardAdmins.id, revokedAt: dashboardAdmins.revokedAt })
      .from(dashboardAdmins)
      .where(eq(dashboardAdmins.clerkUserId, clerkUserId))
      .limit(10);

    // Active = row exists with revokedAt === null
    return rows.some((r) => r.revokedAt === null);
  } catch {
    return false;
  }
}

export async function getWorkspace() {
  const handle = getDb();
  if (!handle) return null;

  try {
    const rows = await handle.db
      .select({ id: workspaces.id, name: workspaces.name, status: workspaces.status })
      .from(workspaces)
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
