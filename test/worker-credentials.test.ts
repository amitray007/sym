import { describe, expect, it } from "vitest";
import { connect } from "../lib/db.ts";
import type { Pack } from "../lib/pack/load.ts";
import {
  getCredential,
  saveCredential,
  type WorkerCredential,
} from "../lib/workers/credentials.ts";
import { resolveWorker, workerTarget } from "../lib/workers/resolve.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const TOKEN = "t3-secret-token-value";

describe.skipIf(!hasDatabase)("worker credential store", () => {
  const ledger = useLedger();

  it("saves one row per worker and replaces it on a new sign-in", async () => {
    const sql = ledger.sql();
    const expiresAt = new Date("2026-11-19T00:00:00Z");
    await saveCredential(sql, {
      worker: "default",
      mcpUrl: "https://worker.example/mcp",
      accessToken: TOKEN,
      expiresAt,
      approvedBy: "UOWNER",
    });
    expect(await getCredential(sql, "default")).toMatchObject({
      worker: "default",
      mcpUrl: "https://worker.example/mcp",
      accessToken: TOKEN,
      expiresAt,
      approvedBy: "UOWNER",
    });

    await saveCredential(sql, {
      worker: "default",
      mcpUrl: "https://worker.example/mcp",
      accessToken: "t3-newer-token",
      expiresAt: null,
      approvedBy: "UOWNER",
    });
    const rows = await sql`select worker from worker_credentials`;
    expect(rows).toHaveLength(1);
    expect((await getCredential(sql, "default"))?.accessToken).toBe("t3-newer-token");
    expect(await getCredential(sql, "other")).toBeUndefined();
  });

  it("keeps the token out of errors", async () => {
    // A schema without the table makes the write fail inside Postgres.
    const empty = connect({ schema: "sym_no_such_schema" });
    try {
      const error = await saveCredential(empty, {
        worker: "default",
        mcpUrl: "https://worker.example/mcp",
        accessToken: TOKEN,
        expiresAt: null,
        approvedBy: null,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const dump = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
      expect(dump).not.toContain(TOKEN);
      expect((error as Error).message).toMatch(/could not save the worker sign-in \(42P01\)/);
      expect((error as Error).cause).toBeUndefined();
    } finally {
      await empty.end();
    }
  });
});

describe("resolveWorker", () => {
  const stored = (row?: Partial<WorkerCredential>) => async (name: string) =>
    row
      ? {
          worker: name,
          mcpUrl: "https://stored.example/mcp",
          accessToken: "stored-token",
          expiresAt: new Date("2026-11-19T00:00:00Z"),
          approvedBy: "UOWNER",
          createdAt: new Date(),
          ...row,
        }
      : undefined;
  const packWith = (mcpUrl: string) =>
    ({ config: { workers: [{ name: "main", kind: "t3", mcpUrl }] } }) as unknown as Pack;
  const env = {
    T3_MCP_URL: "https://env.example/mcp",
    T3_TOKEN: "env-token",
    T3_TOKEN_EXPIRES_AT: "2026-12-01T00:00:00Z",
  };

  it("prefers the stored sign-in", async () => {
    expect(await resolveWorker(undefined, {}, stored({}))).toMatchObject({
      name: "default",
      url: "https://stored.example/mcp",
      token: "stored-token",
      expiresAt: new Date("2026-11-19T00:00:00Z"),
      source: "stored",
    });
    // The stored row matches the configured URL, so it wins over the env token.
    expect(
      await resolveWorker(
        undefined,
        { ...env, T3_MCP_URL: "https://stored.example/mcp/" },
        stored({}),
      ),
    ).toMatchObject({ source: "stored", token: "stored-token" });
  });

  it("looks up the pack's first worker by name", async () => {
    const names: string[] = [];
    await resolveWorker(packWith("https://stored.example/mcp"), {}, async (name) => {
      names.push(name);
      return undefined;
    });
    expect(names).toEqual(["main"]);
    expect(workerTarget(undefined, env)).toEqual({ name: "default", mcpUrl: env.T3_MCP_URL });
  });

  it("falls back to the pack URL with T3_TOKEN, then to T3_MCP_URL", async () => {
    expect(await resolveWorker(packWith("https://pack.example/mcp"), env, stored())).toMatchObject({
      name: "main",
      url: "https://pack.example/mcp",
      token: "env-token",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
      source: "pack",
    });
    expect(await resolveWorker(undefined, env, stored())).toMatchObject({
      name: "default",
      url: "https://env.example/mcp",
      source: "env",
    });
  });

  it("ignores a stored sign-in for another URL than the configured one", async () => {
    expect(await resolveWorker(undefined, env, stored({}))).toMatchObject({ source: "env" });
    expect(
      await resolveWorker(packWith("https://pack.example/mcp"), {}, stored({})),
    ).toBeUndefined();
  });

  it("returns nothing when no URL and token are configured", async () => {
    expect(await resolveWorker(undefined, {}, stored())).toBeUndefined();
    expect(
      await resolveWorker(undefined, { T3_MCP_URL: env.T3_MCP_URL }, stored()),
    ).toBeUndefined();
    expect(await resolveWorker(undefined, { T3_TOKEN: "x" }, stored())).toBeUndefined();
  });
});
