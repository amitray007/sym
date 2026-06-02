/**
 * mcp/oauth-registry.ts — In-flight OAuth authorization registry.
 *
 * When an OAuthProvider's `redirectToAuthorization` fires (during
 * `transport.start()`), we cannot open a browser — we're a server process.
 * Instead we:
 *   1. Record a PendingAuth entry keyed by connector slug.
 *   2. Store the authorize URL so C3b can surface it to Slack.
 *   3. Keep a reference to the transport so `completeOAuth` can call
 *      `transport.finishAuth(code)` after the user clicks through.
 *
 * `completeOAuth(slug, code, state)`:
 *   - Verifies `state` (CSRF: crypto-random, single-use, bound to slug).
 *   - Calls `transport.finishAuth(code)` → SDK exchanges code for tokens
 *     → `saveTokens` → encrypted store.
 *   - Removes the entry (single-use).
 *
 * The state value is generated once per flow (in OAuthProvider.state())
 * and stored here. `completeOAuth` is the ONLY place that accepts a code —
 * it MUST reject any call where `state` does not match the stored value.
 */

import { randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingAuth {
  /** Crypto-random state for CSRF. Single-use — cleared on completeOAuth. */
  state: string;
  /** The URL the user must visit to authorize. */
  authorizeUrl: URL;
  /** Transport waiting for `finishAuth`. */
  transport: StreamableHTTPClientTransport;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Module-level registry: slug → pending auth entry. */
const registry = new Map<string, PendingAuth>();

/**
 * Register a pending authorization flow for `slug`.
 * Called from OAuthProvider.redirectToAuthorization.
 *
 * @param slug - Connector name (used as key in registry and in callback URL).
 * @param authorizeUrl - The authorization URL the user must visit.
 * @param transport - The transport waiting for `finishAuth`.
 * @param state - The CSRF state value that was sent in the authorization URL.
 */
export function registerPendingAuth(
  slug: string,
  authorizeUrl: URL,
  transport: StreamableHTTPClientTransport,
  state: string,
): void {
  registry.set(slug, { state, authorizeUrl, transport });
}

/**
 * Retrieve the pending auth entry for `slug`, or undefined if none exists.
 */
export function getPendingAuth(slug: string): PendingAuth | undefined {
  return registry.get(slug);
}

/**
 * Complete an OAuth authorization flow.
 *
 * Verifies the `state` parameter (CSRF), calls `transport.finishAuth(code)`
 * to exchange the code for tokens (SDK handles PKCE + token endpoint),
 * then removes the single-use entry.
 *
 * @returns 'ok' on success, or throws with a descriptive message on failure.
 * @throws Error if state is invalid/missing (CSRF rejection).
 * @throws Error if `finishAuth` fails (bad code, token endpoint error).
 */
export async function completeOAuth(slug: string, code: string, state: string): Promise<'ok'> {
  const entry = registry.get(slug);

  if (entry === undefined) {
    throw new Error(
      `[oauth] No pending authorization for connector '${slug}'. ` +
        'The flow may have already completed or expired.',
    );
  }

  // CSRF check — constant-time comparison to resist timing attacks.
  const stateOk = timingSafeEqual(entry.state, state);
  if (!stateOk) {
    // Don't leak the expected state in the error message.
    throw new Error(
      `[oauth] State mismatch for connector '${slug}' — possible CSRF attempt. Rejecting.`,
    );
  }

  // Single-use: remove BEFORE awaiting finishAuth so a concurrent call
  // with the same state also fails (replay protection).
  registry.delete(slug);

  // Exchange code for tokens via the SDK. saveTokens is called internally
  // by the OAuthClientProvider (our SdkOAuthAdapter → store.saveTokens).
  await entry.transport.finishAuth(code);

  return 'ok';
}

/**
 * Generate a cryptographically random state string (32 hex bytes = 64 chars).
 */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks on CSRF state.
 *
 * Uses `node:crypto.timingSafeEqual` (a C-level constant-time memcmp).
 *
 * Length-mismatch handling: `crypto.timingSafeEqual` throws when the two
 * Buffers differ in byte length. We guard on the *byte* length (UTF-8
 * encoding) BEFORE calling it rather than the character length, so a string
 * with multi-byte chars is handled correctly. When lengths differ, we still
 * spend a constant time comparing two equal-length dummy buffers to avoid
 * leaking the presence of a length discrepancy as a timing signal.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) {
    // Perform a dummy constant-time comparison so the code path timing is
    // not distinguishable from the equal-length case.
    const dummy = Buffer.alloc(bufA.byteLength);
    cryptoTimingSafeEqual(dummy, dummy);
    return false;
  }
  return cryptoTimingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Clear the registry — test use only. */
export function _resetRegistryForTesting(): void {
  registry.clear();
}
