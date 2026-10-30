import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { signInStates } from "../../lib/connections/credentials.ts";
import { connectionLine, credentialNote, toolDetail } from "../../lib/connections/format.ts";
import { hasTokenEnv } from "../../lib/connections/names.ts";
import { listConnections } from "../../lib/connections/rows.ts";
import { ledger } from "../../lib/runtime.ts";

// Lists the MCP connections (decision 045): status, sign-in kind, whether the token or sign-in
// is there, and tool counts. It never shows a token.
export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "List the MCP connections: name, status, whether the token or sign-in is present, and " +
    "tool counts and the default mode. Give a name to also see each tool with read or write, its mode, and whether the owner set that mode for the tool alone.",
  inputSchema: z.object({ name: z.string().optional() }),
  label: { start: () => "List connections" },
  async execute({ name }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const sql = ledger();
    const all = await listConnections(sql);
    const rows = name ? all.filter((row) => row.name === name) : all;
    if (rows.length === 0) {
      return name ? `There is no connection named "${name}".` : "There are no connections.";
    }
    const now = new Date();
    const signIns = await signInStates(
      sql,
      rows.filter((row) => row.authKind === "oauth").map((row) => row.id),
      now,
    );
    return rows
      .map((row) => {
        const state = {
          tokenSet: hasTokenEnv(row.envVar),
          signIn: signIns.get(row.id) ?? "missing",
        };
        const note = row.status === "disabled" ? undefined : credentialNote(row, state);
        const lines = [connectionLine(row, state)];
        if (note) lines.push(`  ${note}`);
        if (name && row.tools.length > 0) lines.push(toolDetail(row.tools, row.defaultMode));
        return lines.join("\n");
      })
      .join("\n");
  },
});
