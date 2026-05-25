/**
 * Dashboard authentication — three modes, one gate.
 *
 *  - **password** — a single shared password (`SYM_DASHBOARD_PASSWORD`). A correct
 *    password mints a signed, httpOnly session cookie; a valid cookie = the owner.
 *    Single-tenant fit: one password, full access, no Clerk, no per-user admins.
 *    Takes precedence when set ("only password").
 *  - **clerk** — Clerk sign-in + the `dashboard_admins` / bootstrap allowlist gate
 *    (see lib/access.ts). Active when both Clerk keys are set and no password is.
 *  - **open** — no auth configured; renders freely (local dev / `next build`).
 *
 * The session cookie is HMAC-signed with a key DERIVED from `SYM_ENCRYPTION_KEY`
 * (domain-separated), so it's unforgeable without adding a new secret. No user
 * identity is stored — the cookie only attests "this browser entered the
 * password". All functions here are server-only.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';

import { resolveAccess } from './access';

const SESSION_COOKIE = 'sym_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type AuthMode = 'clerk' | 'password' | 'open';

/** Which auth mode is active. Password wins when set; then Clerk; else open. */
export function authMode(): AuthMode {
  if (process.env['SYM_DASHBOARD_PASSWORD']) return 'password';
  if (process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] && process.env['CLERK_SECRET_KEY']) {
    return 'clerk';
  }
  return 'open';
}

// ── password session ──────────────────────────────────────────────────────────

/** HMAC key derived from the encryption key — never the raw key itself. */
function signingKey(): Buffer {
  const base = process.env['SYM_ENCRYPTION_KEY'] ?? '';
  return createHash('sha256').update(`${base}|sym-dashboard-session-v1`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', signingKey()).update(body).digest('base64url');
}

/** Mint a signed session token ("this browser entered the right password"). */
export function createSessionToken(now: number = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ iat: now })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verify a session token's signature (constant-time) and freshness. */
export function verifySessionToken(token: string | undefined, now: number = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(sign(body));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { iat?: number };
    return typeof payload.iat === 'number' && now - payload.iat < SESSION_TTL_MS;
  } catch {
    return false;
  }
}

/** Constant-time check of a submitted password against `SYM_DASHBOARD_PASSWORD`. */
export function verifyPassword(input: string): boolean {
  const expected = process.env['SYM_DASHBOARD_PASSWORD'] ?? '';
  if (!expected) return false;
  // Hash both to fixed-length digests — timingSafeEqual needs equal lengths and
  // this avoids leaking the password length through timing.
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function hasPasswordSession(): Promise<boolean> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value);
}

/** Set the session cookie — called from the sign-in action after a verified password. */
export async function startPasswordSession(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Clear the session cookie (sign-out). */
export async function endPasswordSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

// ── unified gate ────────────────────────────────────────────────────────────

export type GateResult = 'ok' | 'sign-in' | 'request-access';

/**
 * Resolve dashboard access across all three modes. Used by the dashboard layout,
 * the /setup page, and the setup server actions. 'request-access' only occurs in
 * Clerk mode (signed-in but not an admin); password/open never produce it.
 */
export async function dashboardGate(): Promise<GateResult> {
  const mode = authMode();
  if (mode === 'open') return 'ok';
  if (mode === 'password') return (await hasPasswordSession()) ? 'ok' : 'sign-in';

  // clerk
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (!userId) return 'sign-in';
  return (await resolveAccess(userId)).allowed ? 'ok' : 'request-access';
}
