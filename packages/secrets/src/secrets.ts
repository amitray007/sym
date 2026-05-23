import { createRequire } from 'node:module';

// libsodium-wrappers' ESM build is broken (its `.mjs` mis-resolves
// `libsodium.mjs`), so load the working CJS build via createRequire. The type
// comes from the erased dynamic-import type — there is no runtime ESM import of
// the bad module.
const nodeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- CJS-interop typing; a value/namespace import would re-trigger the broken ESM build
const sodium = nodeRequire('libsodium-wrappers') as typeof import('libsodium-wrappers');

/**
 * Application-layer encryption for secret material at rest (libsodium
 * secretbox: XSalsa20-Poly1305). Plaintext is encrypted before it reaches
 * Postgres and decrypted on read, transparently via `@sym/db`'s `encryptedText`
 * column type.
 *
 * Envelope (then base64, `base64_variants.ORIGINAL`):
 *   [version:1][keyIdLen:1][keyId:keyIdLen][nonce:24][cipher:rest]
 *
 * The keyId lets us support **rotation**: encrypt always uses the current key;
 * decrypt selects the key that produced a given ciphertext, so retired keys can
 * still read old rows until everything is re-encrypted via `rotateCiphertext`.
 *
 * libsodium init is async; the encrypt/decrypt surface is sync (Drizzle hooks
 * are sync). Call `initSecrets()` once at process startup before any DB IO.
 */

const ENVELOPE_VERSION = 1;
const KEY_ID_BYTES = 4;

export class SecretsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretsError';
  }
}

interface KeyEntry {
  id: string;
  key: Uint8Array;
}

interface KeyRing {
  current: KeyEntry;
  byId: Map<string, Uint8Array>;
}

let ready = false;
let keyRing: KeyRing | undefined;

function decodeKey(b64: string, label: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = sodium.from_base64(b64.trim(), sodium.base64_variants.ORIGINAL);
  } catch (cause) {
    throw new SecretsError(`${label} is not valid base64`, { cause });
  }
  if (bytes.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new SecretsError(
      `${label} must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes (got ${bytes.length})`,
    );
  }
  return bytes;
}

/** Stable short id for a key: BLAKE2b(key) truncated to KEY_ID_BYTES, hex. */
function keyIdOf(key: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_generichash(KEY_ID_BYTES, key));
}

function buildKeyRing(env: NodeJS.ProcessEnv): KeyRing {
  const primary = env['SYM_ENCRYPTION_KEY'];
  if (!primary) {
    throw new SecretsError('SYM_ENCRYPTION_KEY is required (32-byte base64).');
  }
  const currentKey = decodeKey(primary, 'SYM_ENCRYPTION_KEY');
  const current: KeyEntry = { id: keyIdOf(currentKey), key: currentKey };

  const byId = new Map<string, Uint8Array>();
  byId.set(current.id, currentKey);

  // Optional decrypt-only keys for rotation grace.
  const retired = env['SYM_ENCRYPTION_KEYS_RETIRED'];
  if (retired) {
    for (const part of retired
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const key = decodeKey(part, 'SYM_ENCRYPTION_KEYS_RETIRED entry');
      byId.set(keyIdOf(key), key);
    }
  }
  return { current, byId };
}

/** Await libsodium and load the key ring from env. Idempotent; call at boot. */
export async function initSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await sodium.ready;
  ready = true;
  keyRing = buildKeyRing(env);
}

export function isInitialized(): boolean {
  return ready && keyRing !== undefined;
}

function assertReady(): KeyRing {
  if (!ready || !keyRing) {
    throw new SecretsError('secrets not initialized — call initSecrets() at startup.');
  }
  return keyRing;
}

export function encrypt(plaintext: string): string {
  const ring = assertReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(
    sodium.from_string(plaintext),
    nonce,
    ring.current.key,
  );
  const keyId = sodium.from_hex(ring.current.id);

  const envelope = new Uint8Array(2 + keyId.length + nonce.length + cipher.length);
  envelope[0] = ENVELOPE_VERSION;
  envelope[1] = keyId.length;
  envelope.set(keyId, 2);
  envelope.set(nonce, 2 + keyId.length);
  envelope.set(cipher, 2 + keyId.length + nonce.length);

  return sodium.to_base64(envelope, sodium.base64_variants.ORIGINAL);
}

export function decrypt(ciphertext: string): string {
  const ring = assertReady();

  let envelope: Uint8Array;
  try {
    envelope = sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL);
  } catch (cause) {
    throw new SecretsError('ciphertext is not valid base64', { cause });
  }

  const headerLen = 2 + KEY_ID_BYTES + sodium.crypto_secretbox_NONCEBYTES;
  if (envelope.length < headerLen) {
    throw new SecretsError('ciphertext envelope is truncated');
  }
  if (envelope[0] !== ENVELOPE_VERSION) {
    throw new SecretsError(`unsupported envelope version ${String(envelope[0])}`);
  }

  const keyIdLen = envelope[1] as number;
  const nonceStart = 2 + keyIdLen;
  const nonceEnd = nonceStart + sodium.crypto_secretbox_NONCEBYTES;
  const keyId = sodium.to_hex(envelope.slice(2, nonceStart));
  const nonce = envelope.slice(nonceStart, nonceEnd);
  const cipher = envelope.slice(nonceEnd);

  const key = ring.byId.get(keyId);
  if (!key) {
    throw new SecretsError(`no key for id ${keyId} (rotated out, or wrong deployment)`);
  }

  let message: Uint8Array;
  try {
    message = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  } catch (cause) {
    throw new SecretsError('decryption failed — tampered ciphertext or wrong key', { cause });
  }
  return sodium.to_string(message);
}

/** Re-encrypt a ciphertext under the current key (for key-rotation backfills). */
export function rotateCiphertext(ciphertext: string): string {
  return encrypt(decrypt(ciphertext));
}

/** Mint a fresh 32-byte key as base64 (for SYM_ENCRYPTION_KEY). */
export async function generateKey(): Promise<string> {
  await sodium.ready;
  return sodium.to_base64(
    sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES),
    sodium.base64_variants.ORIGINAL,
  );
}
