/**
 * `@sym/secrets` — application-layer encryption (libsodium secretbox) for
 * secret material at rest. `@sym/db`'s `encryptedText` column type delegates
 * to `encrypt`/`decrypt` here. Apps MUST `await initSecrets()` at boot.
 */
export {
  initSecrets,
  isInitialized,
  encrypt,
  decrypt,
  rotateCiphertext,
  generateKey,
  SecretsError,
} from './secrets.js';
