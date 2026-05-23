import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

/**
 * Resolve DATABASE_URL for CLI scripts (migrate/seed/check/reset), loading the
 * monorepo-root `.env`. The library client (`client.ts`) never touches dotenv —
 * production injects env directly via Dokploy.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadDatabaseUrl(): string {
  const rootEnv = resolve(repoRoot, '.env');
  if (existsSync(rootEnv)) {
    config({ path: rootEnv });
  }
  config();

  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root and set DATABASE_URL.',
    );
  }
  return url;
}
