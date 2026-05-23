import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SecretsError,
  decrypt,
  encrypt,
  generateKey,
  initSecrets,
  isInitialized,
  rotateCiphertext,
} from './secrets.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe('@sym/secrets', () => {
  beforeAll(async () => {
    await initSecrets(env({ SYM_ENCRYPTION_KEY: KEY_A }));
  });

  afterAll(async () => {
    await initSecrets(env({ SYM_ENCRYPTION_KEY: KEY_A }));
  });

  it('initializes', () => {
    expect(isInitialized()).toBe(true);
  });

  it('round-trips utf-8 plaintext', () => {
    const secret = 'xoxb-very-secret-🦴-token';
    const ct = encrypt(secret);
    expect(ct).not.toContain(secret);
    expect(decrypt(ct)).toBe(secret);
  });

  it('writes a versioned envelope (version byte = 1)', () => {
    const bytes = Buffer.from(encrypt('hello'), 'base64');
    expect(bytes[0]).toBe(1);
  });

  it('uses a fresh nonce per call', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('detects tampering', () => {
    const bytes = Buffer.from(encrypt('tamper me'), 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => decrypt(bytes.toString('base64'))).toThrow(SecretsError);
  });

  it('rejects malformed ciphertext', () => {
    expect(() => decrypt('not base64 !!!')).toThrow(SecretsError);
    expect(() => decrypt('AAAA')).toThrow(SecretsError);
  });

  it('guards against an empty/missing key at init', async () => {
    await expect(initSecrets(env({}))).rejects.toThrow(SecretsError);
    // restore a valid ring for subsequent tests
    await initSecrets(env({ SYM_ENCRYPTION_KEY: KEY_A }));
  });

  it('generateKey mints a 32-byte base64 key', async () => {
    expect(Buffer.from(await generateKey(), 'base64')).toHaveLength(32);
  });

  describe('key rotation', () => {
    it('reads old ciphertext via a retired key, then drops it', async () => {
      const ctUnderA = encrypt('rotate me');

      // Rotate: B current, A retired (decrypt-only).
      await initSecrets(env({ SYM_ENCRYPTION_KEY: KEY_B, SYM_ENCRYPTION_KEYS_RETIRED: KEY_A }));
      expect(decrypt(ctUnderA)).toBe('rotate me');

      const ctUnderB = rotateCiphertext(ctUnderA);

      // Drop A entirely.
      await initSecrets(env({ SYM_ENCRYPTION_KEY: KEY_B }));
      expect(decrypt(ctUnderB)).toBe('rotate me');
      expect(() => decrypt(ctUnderA)).toThrow(SecretsError);
    });
  });
});
