/**
 * Bootstrap-aware admin access resolution.
 *
 * Normal admins live in `dashboard_admins`. But a fresh install has zero admins
 * AND zero workspaces — and a `dashboard_admins` row needs a `workspace_id`
 * (NOT NULL FK), which only the Slack install creates, and the install lives
 * behind the admin gate. That is a deadlock: nobody can become the first admin.
 *
 * The break: a configured email allowlist (`SYM_BOOTSTRAP_ADMIN_EMAILS`). A
 * signed-in user whose *verified* Clerk email is on the list is let through on
 * an owner-less instance, and is promoted to `owner` the moment a workspace
 * exists (i.e. right after they complete the install). Once an owner exists the
 * allowlist is ignored.
 *
 * Security model: only a verified Clerk email on the allowlist can claim an
 * owner-less instance. A stranger who reaches the URL first is denied. The
 * decision core (`decideAccess`) is pure and IO-free so the security logic is
 * reviewable at a glance; `resolveAccess` is the thin IO shell around it.
 */

import { dashboardAdmins, workspaces } from '@sym/db';
import { and, eq, isNull } from 'drizzle-orm';

import { isAdmin } from './admin-check';
import { getDb } from './db';

/** Parse `SYM_BOOTSTRAP_ADMIN_EMAILS` (comma-separated) into a lowercased set. */
export function bootstrapEmails(): Set<string> {
  const raw = process.env['SYM_BOOTSTRAP_ADMIN_EMAILS'] ?? '';
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Facts resolved from auth + DB, fed to the pure decision core. */
export interface AccessFacts {
  /** The user already has an active row in `dashboard_admins`. */
  isExistingAdmin: boolean;
  /** The user's verified email is on the bootstrap allowlist. */
  emailAllowlisted: boolean;
  /** A workspace row exists (the install has run). */
  workspaceExists: boolean;
  /** The (single) workspace already has an active owner. */
  ownerExists: boolean;
}

export type AccessDecision =
  /** Established admin — full access. */
  | 'admin'
  /** Allowlisted, but no workspace yet — let them reach /setup to install. */
  | 'bootstrap'
  /** Allowlisted, workspace exists, no owner — claim ownership now. */
  | 'promote'
  /** Not an admin and not eligible to bootstrap. */
  | 'denied';

/**
 * Pure access decision. No IO — given the resolved facts, returns what should
 * happen. This is the entire security policy; keep it small and obvious.
 */
export function decideAccess(facts: AccessFacts): AccessDecision {
  if (facts.isExistingAdmin) return 'admin';
  if (!facts.emailAllowlisted) return 'denied';
  if (!facts.workspaceExists) return 'bootstrap';
  if (facts.ownerExists) return 'denied';
  return 'promote';
}

export interface AccessResult {
  /** True when the user may use the dashboard / setup wizard. */
  allowed: boolean;
  /** True when access is via the bootstrap allowlist (no admin row yet). */
  bootstrap: boolean;
}

const DENIED: AccessResult = { allowed: false, bootstrap: false };

/**
 * Resolve a Clerk user's access, performing first-run owner promotion when
 * eligible. Cheap path first: an established admin never triggers a Clerk
 * email fetch or workspace lookup.
 */
export async function resolveAccess(clerkUserId: string): Promise<AccessResult> {
  // Fast path — established admins skip all bootstrap IO.
  if (await isAdmin(clerkUserId)) return { allowed: true, bootstrap: false };

  const allowlist = bootstrapEmails();
  if (allowlist.size === 0) return DENIED; // bootstrap disabled

  const email = await currentUserEmail();
  if (!email || !allowlist.has(email)) return DENIED; // narrows `email` to string

  const handle = getDb();
  if (!handle) return DENIED; // can't verify or promote without a DB
  const { db } = handle;

  const ws = (await db.select({ id: workspaces.id }).from(workspaces).limit(1))[0];

  const decision = decideAccess({
    isExistingAdmin: false,
    emailAllowlisted: true,
    workspaceExists: Boolean(ws),
    ownerExists: ws ? await hasOwner(db, ws.id) : false,
  });

  switch (decision) {
    case 'bootstrap':
      return { allowed: true, bootstrap: true };
    case 'promote': {
      if (!ws) return DENIED; // unreachable (promote ⇒ workspace) — re-narrows `ws`
      // Promote idempotently + race-safely via the (ws, clerk_user) and
      // one-owner-per-ws unique indexes.
      await db
        .insert(dashboardAdmins)
        .values({ workspaceId: ws.id, clerkUserId, email, role: 'owner' })
        .onConflictDoNothing();
      // Confirm the row is ours — a concurrent claimant may have won the race.
      return { allowed: await isAdmin(clerkUserId), bootstrap: false };
    }
    default:
      return DENIED;
  }
}

/** Whether the workspace already has an active (non-revoked) owner. */
async function hasOwner(db: NonNullable<ReturnType<typeof getDb>>['db'], wsId: string) {
  const row = (
    await db
      .select({ id: dashboardAdmins.id })
      .from(dashboardAdmins)
      .where(
        and(
          eq(dashboardAdmins.workspaceId, wsId),
          eq(dashboardAdmins.role, 'owner'),
          isNull(dashboardAdmins.revokedAt),
        ),
      )
      .limit(1)
  )[0];
  return Boolean(row);
}

/** The current Clerk user's primary *verified* email, lowercased. */
async function currentUserEmail(): Promise<string | null> {
  const { currentUser } = await import('@clerk/nextjs/server');
  const user = await currentUser();
  if (!user) return null;
  const primary =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
  if (!primary) return null;
  // Only a verified email may claim ownership.
  if (primary.verification?.status !== 'verified') return null;
  return primary.emailAddress.toLowerCase();
}
