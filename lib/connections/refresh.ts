import type { Sql } from "../db.ts";
import { relistTools } from "./add.ts";
import type { Probe, ProbeOptions } from "./probe.ts";
import { type Connection, saveTools } from "./rows.ts";

// Lists an active connection again once Sym can reach it with its credential (decision 048).
//
// The first probe of a token server is anonymous and gets a 401, so the row has no tools and no
// instructions. A row from before migration 013 has tools but no instructions. The loader in
// agent/connections/rows.ts calls this at each turn. A row is probed at most once per
// REFRESH_EVERY_MS in one process, whatever the outcome, so a server that sends no instructions
// or a server that is down does not slow every turn.

export const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 4_000;

export function needsRefresh(row: Connection): boolean {
  return row.status === "active" && (row.tools.length === 0 || row.serverInstructions === null);
}

export interface RefreshDeps {
  sql: Sql;
  probe(url: string, options?: ProbeOptions): Promise<Probe>;
  // The connection's bearer token, if it has one now (lib/connections/auth.ts connectionToken).
  token(row: Connection): Promise<{ token: string } | undefined>;
  // When each row ID was last probed. Owned by the caller, so it lives as long as the process.
  attempts: Map<number, number>;
  now: Date;
}

// Returns the rows with fresh tools and instructions where a refresh worked. A failure keeps
// the stored row. The owner's tool modes survive (recordTools keeps them).
export async function refreshStale(
  rows: readonly Connection[],
  deps: RefreshDeps,
): Promise<Connection[]> {
  const now = deps.now.getTime();
  return Promise.all(
    rows.map(async (row) => {
      if (!needsRefresh(row)) return row;
      const last = deps.attempts.get(row.id);
      if (last !== undefined && now - last < REFRESH_EVERY_MS) return row;
      try {
        const credential = await deps.token(row);
        if (row.authKind !== "none" && !credential) return row;
        deps.attempts.set(row.id, now);
        const listed = await relistTools(row.url, credential?.token, row.tools, (url, options) =>
          deps.probe(url, { ...options, timeoutMs: REFRESH_TIMEOUT_MS }),
        );
        if (!listed.ok) return row;
        return (await saveTools(deps.sql, row.id, listed.tools, listed.instructions)) ?? row;
      } catch {
        return row;
      }
    }),
  );
}
