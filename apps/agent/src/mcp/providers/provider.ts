/**
 * CredentialProvider — the acquisition axis of the three-axis connector model.
 *
 * `makeProvider(auth)` is the ONLY place an auth kind is switched. All
 * callers go through this factory; no other code inspects `auth.kind`.
 *
 * Implemented now:
 *   'static'  → StaticProvider (inline secret, env/argv injection)
 *
 * Stubs (typed seams, throw NotImplementedError):
 *   'oauth'   → C3
 *   undefined → null (no auth — no provider created)
 */

import { StaticProvider } from './static.js';

import type { AuthConfig } from '../config.js';
import type { Materializer } from '../materialize.js';

// ---------------------------------------------------------------------------
// ResolvedCredential
// ---------------------------------------------------------------------------

/**
 * What a CredentialProvider hands to the injector after resolving credentials.
 *
 * Each variant maps 1:1 to an injection target:
 *  - env     → merge vars into child process environment (stdio)
 *  - argv    → append args to child command line (stdio)
 *  - headers → add HTTP headers (C2 — http transport)
 *  - files   → write credential files to a temp dir (C2.5 — with Materializer)
 *  - native  → pass an OAuthClientProvider to the SDK (C3)
 *  - none    → no credential; injector is a no-op
 */
export type ResolvedCredential =
  | { apply: 'env'; vars: Record<string, string> }
  | { apply: 'argv'; args: string[] }
  | { apply: 'headers'; headers: Record<string, string> } // C2
  | { apply: 'files'; dir: string; vars: Record<string, string> } // C2.5
  | { apply: 'native'; oauth: unknown } // C3 (SDK OAuthClientProvider)
  | { apply: 'none' };

// ---------------------------------------------------------------------------
// CredentialProvider interface
// ---------------------------------------------------------------------------

export interface CredentialProvider {
  resolve(): Promise<ResolvedCredential>;
  /**
   * Optional refresh — base implementations return null (no rotation).
   * C3 OAuth provider will implement rotation here.
   */
  refresh?(): Promise<ResolvedCredential | null>;
}

// ---------------------------------------------------------------------------
// makeProvider — the single switch
// ---------------------------------------------------------------------------

/**
 * Optional deps for makeProvider — used for testing (inject a custom Materializer).
 * All fields are optional; defaults are applied when absent.
 */
export interface MakeProviderDeps {
  /**
   * Materializer instance to use for file injection.
   * Defaults to the singleton `defaultMaterializer` when absent.
   */
  materializer?: Materializer;
}

/**
 * Create a `CredentialProvider` from an `AuthConfig`, or return `null` if no
 * auth is configured.
 *
 * `makeProvider` is the ONLY place that switches on `auth.kind`. Consumers
 * call this once and use the provider interface from then on.
 *
 * @param auth - The auth config, or undefined for no auth.
 * @param deps - Optional dependency overrides (e.g. custom Materializer for tests).
 */
export function makeProvider(
  auth: AuthConfig | undefined,
  deps?: MakeProviderDeps,
): CredentialProvider | null {
  if (auth === undefined) return null;

  if (auth.kind === 'static') {
    return new StaticProvider(auth, deps?.materializer);
  }

  if (auth.kind === 'oauth') {
    throw new NotImplementedError('oauth CredentialProvider — C3');
  }

  // TypeScript exhaustiveness check — if a new kind is added to AuthConfig
  // and makeProvider is not updated, this will be a compile error.
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth kind: ${JSON.stringify(_exhaustive)}`);
}

// ---------------------------------------------------------------------------
// NotImplementedError — named stub marker used throughout mcp/
// ---------------------------------------------------------------------------

/**
 * Thrown when a feature axis is reached that is stubbed for a future chunk.
 * The message names the chunk so operators know when to expect it.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}
