import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
export type SqlClient = ReturnType<typeof postgres>;

export interface DbHandle {
  db: Database;
  client: SqlClient;
  close: () => Promise<void>;
}

/**
 * Build a Drizzle client over a postgres-js connection. No env loading and no
 * import-time side effects — the caller supplies the connection string (the
 * Agent/Dashboard read it from injected env; CLI scripts use `loadDatabaseUrl`).
 */
export function createDb(connectionString: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(connectionString, { max: options.max ?? 10 });
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    close: async () => {
      await client.end();
    },
  };
}
