import { defineDynamic } from "eve/connections";
import { isWorkerCaller } from "../../lib/callers.ts";
import { connectionToken } from "../../lib/connections/auth.ts";
import { signInStates } from "../../lib/connections/credentials.ts";
import { connectionDefinitions } from "../../lib/connections/load.ts";
import { activeConnections } from "../../lib/connections/rows.ts";
import { ownerResponse } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The MCP connections the owner approved (decision 045). They load at each turn, so a new
// approval, a tool mode change, or a removal applies to the next message. Worker threads get no
// connections. The resolver only reads rows, because Eve may run it again during recovery. A
// failed read loads nothing instead of failing the turn.
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (isWorkerCaller(ctx.session.auth.current)) return null;
      try {
        const sql = ledger();
        const rows = await activeConnections(sql);
        if (rows.length === 0) return null;
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
