import { customType } from 'drizzle-orm/pg-core';

/**
 * `encryptedText` — a Postgres `text` column for secret material.
 *
 * Sp2 ships this as a PASSTHROUGH: it stores and returns plaintext. The
 * column DDL is a plain `text`, so when Sp4 (`@sym/secrets`) wires libsodium
 * into `toDriver`/`fromDriver` (encrypt on write, decrypt on read) there is
 * ZERO migration impact — only this file changes.
 *
 * TODO(Sp4): replace the passthrough bodies with libsodium secretbox using
 * the per-workspace key from SYM_ENCRYPTION_KEY. Reads that don't need the
 * plaintext should use the ciphertext directly to avoid decryption cost.
 *
 * Until then: DO NOT put real production secrets in a Sym instance built at
 * this commit — values are stored in cleartext.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value: string): string {
    return value;
  },
  fromDriver(value: string): string {
    return value;
  },
});
