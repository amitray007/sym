import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load the monorepo-root .env so `drizzle-kit studio`/`push` find DATABASE_URL.
// `generate` works without a connection (it only diffs the schema).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: resolve(repoRoot, '.env') });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: true,
});
