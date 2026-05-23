import { encrypt, decrypt } from '@sym/secrets';
import { customType } from 'drizzle-orm/pg-core';

/**
 * `encryptedText` — a Postgres `text` column whose value is encrypted at rest
 * via `@sym/secrets` (libsodium secretbox). Encrypts on write, decrypts on
 * read, transparently. The column DDL is a plain `text`, so this carries no
 * migration weight.
 *
 * Requires `await initSecrets()` to have run at process startup (it loads the
 * key ring from `SYM_ENCRYPTION_KEY`). If it hasn't, encrypt/decrypt throw —
 * fail-closed, never silently store plaintext.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value: string): string {
    return encrypt(value);
  },
  fromDriver(value: string): string {
    return decrypt(value);
  },
});
