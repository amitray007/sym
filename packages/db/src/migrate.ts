import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { loadDatabaseUrl } from './cli-env.js';
import { createDb } from './client.js';

async function main(): Promise<void> {
  const { db, close } = createDb(loadDatabaseUrl(), { max: 1 });
  const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
  console.info('[db:migrate] applying migrations from ./migrations …');
  await migrate(db, { migrationsFolder });
  console.info('[db:migrate] done.');
  await close();
}

main().catch((err: unknown) => {
  console.error('[db:migrate] failed:', err);
  process.exit(1);
});
