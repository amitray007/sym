import { defineDynamic } from "eve/connections";
import { isWorkerCaller } from "../../lib/callers.ts";
import { connectionToken } from "../../lib/connections/auth.ts";
import { type SignInState, signInStates } from "../../lib/connections/credentials.ts";
import { connectionDefinitions } from "../../lib/connections/load.ts";
import { probeServer } from "../../lib/connections/probe.ts";
import { refreshStale } from "../../lib/connections/refresh.ts";
import { activeConnections, type Connection } from "../../lib/connections/rows.ts";
import { ownerResponse } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The MCP connections the owner approved (decision 045). They load at each turn, so a new
// approval, a tool mode change, or a removal applies to the next message. Worker threads get no
// connections. A failed read loads nothing instead of failing the turn.
//
// One write happens here (decision 048): a connection that now has its credential but no tools
// or no server instructions is listed again, at most once per six hours per process. That is
// how a token server gets its tools and instructions after the owner sets the env var. The
// write is idempotent, so Eve may run the resolver again during recovery.
const attempts = new Map<number, number>();

// Eve evaluates this before every model call. The turn-keyed memo keeps the read and the refresh
// to once per turn, as before. A memo holds plain JSON, so the dates come back as strings and are
// revived here. The connection callbacks are rebuilt from the rows at each evaluation.
export default defineDynamic(async (ctx) => {
  if (isWorkerCaller(ctx.session.auth.current)) return null;
  try {
    const sql = ledger();
    // A failed read is saved as no rows, so the turn keeps no connections, as before, instead of
    // reading again before every model call.
    const saved = await ctx.memo(["rows", ctx.turn?.id ?? null], async () => {
      try {
        return await readRows(sql);
      } catch (error) {
        console.warn(
          "connections: could not load rows",
          error instanceof Error ? error.message : String(error),
        );
        return { rows: [], signIns: [] };
      }
    });
    if (saved.rows.length === 0) return null;
    const definitions = connectionDefinitions(saved.rows.map(reviveRow), {
      env: process.env,
      signIns: new Map(saved.signIns),
      token: (row) => connectionToken(sql, row),
      response: ownerResponse(pack),
    });
    return Object.keys(definitions).length > 0 ? definitions : null;
  } catch (error) {
    console.warn(
      "connections: could not build connections",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
});

async function readRows(
  sql: ReturnType<typeof ledger>,
): Promise<{ rows: JsonRow[]; signIns: [number, SignInState][] }> {
  const stored = await activeConnections(sql);
  if (stored.length === 0) return { rows: [], signIns: [] };
  const rows = await refreshStale(stored, {
    sql,
    probe: probeServer,
    token: (row) => connectionToken(sql, row),
    attempts,
    now: new Date(),
  });
  const oauthIds = rows.filter((row) => row.authKind === "oauth").map((row) => row.id);
  const signIns = await signInStates(sql, oauthIds, new Date());
  return { rows: JSON.parse(JSON.stringify(rows)) as JsonRow[], signIns: [...signIns] };
}

type JsonRow = Omit<Connection, "approvedAt" | "createdAt" | "updatedAt"> & {
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function reviveRow(row: JsonRow): Connection {
  return {
    ...row,
    approvedAt: row.approvedAt ? new Date(row.approvedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}
