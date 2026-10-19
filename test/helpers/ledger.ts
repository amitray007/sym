import { randomBytes } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { connect, type Sql } from "../../lib/db.ts";
import { migrate } from "../../lib/ledger/migrate.ts";

// Ledger tests need a real Postgres: `pnpm db:up`, then set DATABASE_URL. CI runs a service.
export const hasDatabase = Boolean(process.env.DATABASE_URL);

// Gives the calling test file its own migrated schema, dropped after the file finishes, so test
// files can run in parallel.
export function useLedger(): { sql: () => Sql } {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let sql: Sql | undefined;

  beforeAll(async () => {
    const admin = connect();
    await admin.unsafe(`create schema ${schema}`);
    await admin.end();
    sql = connect({ schema });
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
    const admin = connect();
    await admin.unsafe(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  return {
    sql: () => {
      if (!sql) throw new Error("useLedger: the database is not ready");
      return sql;
    },
  };
}
