/**
 * cli/secrets.ts — Thin helpers for `sym secret set|ls|rm`.
 *
 * Wraps the encrypted SQLite credential store (`SqliteCredentialStore`) with
 * a minimal, testable surface:
 *
 *   setSecret    — store a static API key / token for a connector field.
 *   listSecrets  — enumerate stored secret identities (names only, no values).
 *   removeSecret — delete a stored secret.
 *
 * The optional `store?` parameter on every function allows tests to inject an
 * in-memory store; production callers pass nothing and rely on `openStore()`.
 */

import { SqliteCredentialStore } from '@sym/mcp-runtime';

import type { CredentialStore, SecretRef } from '@sym/mcp-runtime';

// ---------------------------------------------------------------------------
// Internal store factory
// ---------------------------------------------------------------------------

/**
 * Open the production credential store using env-configured path and key.
 *
 * Wraps the `SqliteCredentialStore` constructor so that a missing or invalid
 * `SYM_ENCRYPTION_KEY` produces a user-friendly error that names this command.
 */
function openStore(): CredentialStore {
  try {
    return new SqliteCredentialStore();
  } catch (cause) {
    throw new Error(
      '[sym secret] Cannot open the credential store. ' +
        'Ensure SYM_ENCRYPTION_KEY is set to a valid 32-byte base64 or hex key. ' +
        'Generate one with: openssl rand -base64 32',
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a static secret for `connector` / `field`.
 *
 * @param connector - Connector name (e.g. `'sentry'`).
 * @param field     - Field name (e.g. `'SENTRY_AUTH_TOKEN'`).
 * @param value     - Plaintext secret value. Encrypted at rest.
 * @param store     - Injected store for tests; omit in production.
 */
export function setSecret(
  connector: string,
  field: string,
  value: string,
  store?: CredentialStore,
): void {
  (store ?? openStore()).saveSecret(connector, field, value);
}

/**
 * List all stored static-secret identities (connector + field names only).
 *
 * Values are never returned — callers cannot read back secrets via this helper.
 *
 * @param store - Injected store for tests; omit in production.
 */
export function listSecrets(store?: CredentialStore): SecretRef[] {
  return (store ?? openStore()).listSecretRefs();
}

/**
 * Remove a stored static secret for `connector` / `field`.
 *
 * No-ops silently if the secret does not exist.
 *
 * @param connector - Connector name.
 * @param field     - Field name.
 * @param store     - Injected store for tests; omit in production.
 */
export function removeSecret(connector: string, field: string, store?: CredentialStore): void {
  (store ?? openStore()).deleteSecret(connector, field);
}
