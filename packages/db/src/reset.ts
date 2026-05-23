import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { loadDatabaseUrl } from './cli-env.js';
import { createDb } from './client.js';

/**
 * Dev-only: drop and recreate the `public` schema, then re-migrate clean.
 * Refuses to run when NODE_ENV=production.
 */
async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('[db:reset] refused: NODE_ENV=production');
  }

  const { db, close } = createDb(loadDatabaseUrl(), { max: 1 });

  console.warn('[db:reset] dropping public + drizzle (migration journal) schemas');
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE;`);
  // The migrator tracks applied migrations in `drizzle.__drizzle_migrations`;
  // drop it too or the re-migrate sees 0000 as applied and creates nothing.
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE;`);
  await db.execute(sql`CREATE SCHEMA public;`);

  const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
  await migrate(db, { migrationsFolder });
  console.info('[db:reset] re-migrated clean schema.');

  await close();
}

main().catch((err: unknown) => {
  console.error('[db:reset] failed:', err);
  process.exit(1);
});
