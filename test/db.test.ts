import { describe, expect, it } from "vitest";
import { connect, databaseUrl } from "../lib/db.ts";

describe("databaseUrl", () => {
  it("accepts a postgres URL", () => {
    const url = "postgres://sym:sym@localhost:55432/sym";
    expect(databaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("accepts the postgresql scheme", () => {
    const url = "postgresql://sym:sym@db.internal/sym";
    expect(databaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("rejects a missing value", () => {
    expect(() => databaseUrl({})).toThrow("DATABASE_URL must be a postgres:// URL");
  });

  // Decision 064: Eve's .env reload can restore the owner's DATABASE_URL during an eval run.
  it("uses only the eval database in an eval run", () => {
    const owner = "postgres://sym:sym@localhost:55432/sym";
    const evals = "postgres://sym:sym@localhost:55432/sym_eval";
    const run = { EVE_EVALUATION: "1", DATABASE_URL: owner };
    expect(databaseUrl({ ...run, SYM_EVAL_DATABASE_URL: evals })).toBe(evals);
    expect(() => databaseUrl(run)).toThrow("SYM_EVAL_DATABASE_URL must be a postgres:// URL");
  });

  it("rejects another scheme without echoing the value", () => {
    const secret = "mysql://sym:hunter2@localhost/sym";
    expect(() => databaseUrl({ DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2") }),
    );
  });
});

// Needs a real Postgres: `pnpm db:up`, then set DATABASE_URL. CI runs a Postgres service.
describe.skipIf(!process.env.DATABASE_URL)("connect", () => {
  it("runs a query against the ledger database", async () => {
    const sql = connect();
    try {
      const [row] = await sql<{ one: number }[]>`select 1 as one`;
      expect(row?.one).toBe(1);
    } finally {
      await sql.end();
    }
  });
});
