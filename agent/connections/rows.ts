import { defineDynamic } from "eve/connections";
import { isWorkerCaller } from "../../lib/callers.ts";
import { connectionToken } from "../../lib/connections/auth.ts";
import { signInStates } from "../../lib/connections/credentials.ts";
import { connectionDefinitions } from "../../lib/connections/load.ts";
import { probeServer } from "../../lib/connections/probe.ts";
import { refreshStale } from "../../lib/connections/refresh.ts";
import { activeConnections } from "../../lib/connections/rows.ts";
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

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (isWorkerCaller(ctx.session.auth.current)) return null;
      try {
        const sql = ledger();
        const stored = await activeConnections(sql);
        if (stored.length === 0) return null;
        const rows = await refreshStale(stored, {
          sql,
          probe: probeServer,
          token: (row) => connectionToken(sql, row),
          attempts,
          now: new Date(),
        });
        const oauthIds = rows.filter((row) => row.authKind === "oauth").map((row) => row.id);
        const definitions = connectionDefinitions(rows, {
          env: process.env,
          signIns: await signInStates(sql, oauthIds, new Date()),
          token: (row) => connectionToken(sql, row),
          response: ownerResponse(pack),
        });
        return Object.keys(definitions).length > 0 ? definitions : null;
      } catch (error) {
        console.warn(
          "connections: could not load rows",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
    },
  },
});
