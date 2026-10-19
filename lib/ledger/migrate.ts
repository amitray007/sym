import type { Sql } from "../db.ts";
import { type Migration, migrations } from "./migrations.ts";

// Any fixed number works. It stops two processes from migrating at once.
const MIGRATION_LOCK = 4_242_001;

// Applies pending migrations in one transaction and returns their versions.
export async function migrate(sql: Sql, all: Migration[] = migrations): Promise<string[]> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    const rows = await tx<{ version: string }[]>`select version from schema_migrations`;
    const done = new Set(rows.map((row) => row.version));
    const applied: string[] = [];
    for (const migration of all) {
      if (done.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`insert into schema_migrations (version) values (${migration.version})`;
      applied.push(migration.version);
    }
    return applied;
  });
}
