/**
 * mcp/store.ts — Encrypted credential store for OAuth provider data.
 *
 * Backed by node:sqlite (DatabaseSync) + node:crypto (AES-256-GCM).
 * Persists, PER CONNECTOR NAME:
 *   - clientInformation (DCR result)
 *   - tokens            (access/refresh/expiry)
 *   - codeVerifier      (PKCE — transient)
 *   - discoveryState    (optional, reduces round-trips)
 *
 * All values are encrypted at rest (AES-256-GCM). If SYM_ENCRYPTION_KEY
 * is missing or invalid (not 32-byte base64/hex), the constructor throws —
 * NEVER writes plaintext. Secrets are never logged.
 *
 * DB path: SYM_DB_PATH env (default: <cwd>/.sym/credentials.db).
 * Tests pass ':memory:'.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A stored static secret's identity — connector + field name, NEVER the value. */
export interface SecretRef {
  connector: string;
  field: string;
}

export interface CredentialStore {
  getClientInformation(connectorName: string): OAuthClientInformationMixed | undefined;
  saveClientInformation(connectorName: string, info: OAuthClientInformationMixed): void;
  getTokens(connectorName: string): OAuthTokens | undefined;
  saveTokens(connectorName: string, tokens: OAuthTokens): void;
  /**
   * Delete the stored OAuth tokens for a connector (Z08-05).
   * After this call, `getTokens(connectorName)` returns `undefined`,
   * forcing a fresh authorization flow on the next connect attempt.
   */
  deleteTokens(connectorName: string): void;
  getCodeVerifier(connectorName: string): string | undefined;
  saveCodeVerifier(connectorName: string, verifier: string): void;
  clearCodeVerifier(connectorName: string): void;
  getDiscoveryState(connectorName: string): OAuthDiscoveryState | undefined;
  saveDiscoveryState(connectorName: string, state: OAuthDiscoveryState): void;

  // Generic static secrets — written by `sym secret set`, read by the
  // (future) `secretRef` static-credential injection path. Stored under a
  // reserved field namespace so they never collide with OAuth fields above.
  saveSecret(connectorName: string, field: string, value: string): void;
  getSecret(connectorName: string, field: string): string | undefined;
  deleteSecret(connectorName: string, field: string): void;
  /** All stored static-secret identities (connector + field) — never values. */
  listSecretRefs(): SecretRef[];
}

// ---------------------------------------------------------------------------
// AES-256-GCM encryption helpers
// ---------------------------------------------------------------------------

const ALGO = 'aes-256-gcm' as const;
const IV_LEN = 12; // 96-bit IV for GCM

/** Encrypted blob stored in SQLite: `<iv_hex>:<tag_hex>:<ciphertext_hex>` */
type EncryptedBlob = string;

function encrypt(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(key: Buffer, blob: EncryptedBlob): string {
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted blob format');
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

/**
 * Parse SYM_ENCRYPTION_KEY (base64 or hex) into a 32-byte Buffer.
 * Throws if absent or not exactly 32 bytes after decoding.
 * This is FAIL-CLOSED: the store cannot be used without a valid key.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      '[mcp/store] SYM_ENCRYPTION_KEY is required but not set. ' +
        'Generate a 32-byte key: openssl rand -base64 32',
    );
  }

  // Try base64 first (44 chars for 32 bytes), then hex (64 chars for 32 bytes).
  const trimmed = raw.trim();
  let buf: Buffer;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, 'hex');
  } else {
    // Attempt base64 — Buffer.from accepts it.
    buf = Buffer.from(trimmed, 'base64');
  }

  if (buf.length !== 32) {
    throw new Error(
      `[mcp/store] SYM_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). ` +
        'Provide a 32-byte key as base64 or hex.',
    );
  }

  return buf;
}

// ---------------------------------------------------------------------------
// SqliteCredentialStore
// ---------------------------------------------------------------------------

const DEFAULT_DB_DIR = '.sym';
const DEFAULT_DB_FILE = 'credentials.db';

/** Reserved field-name prefix for generic static secrets (vs OAuth fields). */
const SECRET_FIELD_PREFIX = 'secret:';

/**
 * SQLite-backed credential store with AES-256-GCM encryption.
 *
 * @param dbPath - SQLite file path or ':memory:' for tests.
 *                 Defaults to `SYM_DB_PATH` env, then `.sym/credentials.db`.
 * @param encryptionKey - 32-byte key as base64 or hex.
 *                        Defaults to `SYM_ENCRYPTION_KEY` env.
 *                        Throws (fail-closed) if absent/invalid.
 */
export class SqliteCredentialStore implements CredentialStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(dbPath?: string, encryptionKeyRaw?: string) {
    // Resolve db path
    const resolvedPath =
      dbPath ?? process.env['SYM_DB_PATH'] ?? `${DEFAULT_DB_DIR}/${DEFAULT_DB_FILE}`;

    // Fail-closed: key must be valid before we open/create the DB.
    this.key = parseEncryptionKey(encryptionKeyRaw ?? process.env['SYM_ENCRYPTION_KEY']);

    // Create parent dirs if needed (not for :memory:).
    if (resolvedPath !== ':memory:') {
      try {
        mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
      } catch {
        // Ignore if already exists or can't create (will fail on open).
      }
    }

    this.db = new DatabaseSync(resolvedPath);

    // Best-effort: restrict the DB file to owner-only after open. Wrapping in
    // try/catch because some filesystems (e.g. FAT32, some network mounts)
    // silently ignore or reject chmod — fail-open so the store still works.
    if (resolvedPath !== ':memory:') {
      try {
        chmodSync(resolvedPath, 0o600);
      } catch {
        // Non-fatal — the file is encrypted at rest regardless.
      }
    }

    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_credentials (
        connector_name  TEXT NOT NULL,
        field           TEXT NOT NULL,
        value_enc       TEXT NOT NULL,
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (connector_name, field)
      )
    `);
  }

  // ---------------------------------------------------------------------------
  // Internal get/set with encryption
  // ---------------------------------------------------------------------------

  private _get(connectorName: string, field: string): string | undefined {
    const stmt = this.db.prepare(
      'SELECT value_enc FROM mcp_credentials WHERE connector_name = ? AND field = ?',
    );
    const row = stmt.get(connectorName, field) as { value_enc: string } | undefined;
    if (row === undefined) return undefined;
    return decrypt(this.key, row.value_enc);
  }

  private _set(connectorName: string, field: string, plaintext: string): void {
    const blob = encrypt(this.key, plaintext);
    const stmt = this.db.prepare(`
      INSERT INTO mcp_credentials (connector_name, field, value_enc, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT (connector_name, field) DO UPDATE SET
        value_enc  = excluded.value_enc,
        updated_at = excluded.updated_at
    `);
    stmt.run(connectorName, field, blob);
  }

  private _delete(connectorName: string, field: string): void {
    const stmt = this.db.prepare(
      'DELETE FROM mcp_credentials WHERE connector_name = ? AND field = ?',
    );
    stmt.run(connectorName, field);
  }

  // ---------------------------------------------------------------------------
  // CredentialStore interface
  // ---------------------------------------------------------------------------

  getClientInformation(connectorName: string): OAuthClientInformationMixed | undefined {
    const raw = this._get(connectorName, 'client_information');
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as OAuthClientInformationMixed;
  }

  saveClientInformation(connectorName: string, info: OAuthClientInformationMixed): void {
    this._set(connectorName, 'client_information', JSON.stringify(info));
  }

  getTokens(connectorName: string): OAuthTokens | undefined {
    const raw = this._get(connectorName, 'tokens');
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as OAuthTokens;
  }

  saveTokens(connectorName: string, tokens: OAuthTokens): void {
    this._set(connectorName, 'tokens', JSON.stringify(tokens));
  }

  deleteTokens(connectorName: string): void {
    this._delete(connectorName, 'tokens');
  }

  getCodeVerifier(connectorName: string): string | undefined {
    return this._get(connectorName, 'code_verifier');
  }

  saveCodeVerifier(connectorName: string, verifier: string): void {
    this._set(connectorName, 'code_verifier', verifier);
  }

  clearCodeVerifier(connectorName: string): void {
    this._delete(connectorName, 'code_verifier');
  }

  getDiscoveryState(connectorName: string): OAuthDiscoveryState | undefined {
    const raw = this._get(connectorName, 'discovery_state');
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as OAuthDiscoveryState;
  }

  saveDiscoveryState(connectorName: string, state: OAuthDiscoveryState): void {
    this._set(connectorName, 'discovery_state', JSON.stringify(state));
  }

  // ---------------------------------------------------------------------------
  // Generic static secrets — namespaced under `secret:` so they never collide
  // with the OAuth fields above and `listSecretRefs` can enumerate just them.
  // ---------------------------------------------------------------------------

  saveSecret(connectorName: string, field: string, value: string): void {
    this._set(connectorName, `${SECRET_FIELD_PREFIX}${field}`, value);
  }

  getSecret(connectorName: string, field: string): string | undefined {
    return this._get(connectorName, `${SECRET_FIELD_PREFIX}${field}`);
  }

  deleteSecret(connectorName: string, field: string): void {
    this._delete(connectorName, `${SECRET_FIELD_PREFIX}${field}`);
  }

  listSecretRefs(): SecretRef[] {
    const stmt = this.db.prepare(
      'SELECT connector_name, field FROM mcp_credentials WHERE field LIKE ? ORDER BY connector_name, field',
    );
    const rows = stmt.all(`${SECRET_FIELD_PREFIX}%`) as { connector_name: string; field: string }[];
    return rows.map((r) => ({
      connector: r.connector_name,
      field: r.field.slice(SECRET_FIELD_PREFIX.length),
    }));
  }

  /**
   * Raw read for testing only — returns the raw encrypted blob (NOT the
   * plaintext). Used to assert values are NOT stored in plaintext.
   *
   * @internal test-only
   */
  _getRawEncryptedForTesting(connectorName: string, field: string): string | undefined {
    const stmt = this.db.prepare(
      'SELECT value_enc FROM mcp_credentials WHERE connector_name = ? AND field = ?',
    );
    const row = stmt.get(connectorName, field) as { value_enc: string } | undefined;
    return row?.value_enc;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (lazily created)
// ---------------------------------------------------------------------------

let _store: SqliteCredentialStore | undefined;

/**
 * Return the process-level credential store singleton.
 *
 * Lazily creates the store on first call.  Throws (fail-closed) if
 * SYM_ENCRYPTION_KEY is not set.
 *
 * Tests should NOT call this — they construct their own SqliteCredentialStore
 * with ':memory:' + a test key.
 */
export function getStore(): SqliteCredentialStore {
  if (_store === undefined) {
    _store = new SqliteCredentialStore();
  }
  return _store;
}

/** Reset the singleton — test use only. */
export function _resetStoreForTesting(): void {
  _store = undefined;
}
