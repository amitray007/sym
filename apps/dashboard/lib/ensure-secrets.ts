/**
 * Memoized `initSecrets()` — the provider API key is written to an
 * `encryptedText` column, which encrypts via `@sym/secrets`; that requires the
 * key ring to be loaded once. Server actions call this before writing secrets.
 */

let initialized: Promise<void> | null = null;

export function ensureSecrets(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      const { initSecrets } = await import('@sym/secrets');
      await initSecrets();
    })();
  }
  return initialized;
}
