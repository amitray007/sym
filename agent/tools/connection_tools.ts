import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { relistTools } from "../../lib/connections/add.ts";
import { connectionToken } from "../../lib/connections/auth.ts";
import { modePrompt } from "../../lib/connections/format.ts";
import { probeServer } from "../../lib/connections/probe.ts";
import { getConnection, saveTools, setToolMode } from "../../lib/connections/rows.ts";
import { TOOL_MODES, type ToolMode } from "../../lib/connections/tools.ts";
import {
  mayDecideAsOwner,
  OWNER_ONLY,
  ownerResponse,
  slackUserOfPrincipal,
} from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The owner changes how one connection tool runs (decision 045): auto, ask, or hidden.
export default defineTool({
  description:
    "Change how one tool of an MCP connection runs, when the owner asks: auto runs without " +
    "asking, ask needs the owner's approval for every call, hidden removes it. The owner " +
    "approves the change.",
  inputSchema: z.object({
    name: z.string().describe("The connection name."),
    tool: z.string().describe("The tool name as connection_list shows it."),
    mode: z.enum(TOOL_MODES as [ToolMode, ...ToolMode[]]),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) => modePrompt(input.name, input.tool, input.mode),
  },
  label: { start: ({ name, tool }) => `Set ${name} ${tool}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const caller = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!mayDecideAsOwner(caller, pack())) return OWNER_ONLY;
    const sql = ledger();
    let row = await getConnection(sql, input.name);
    if (row?.status !== "active") {
      return `There is no active connection named "${input.name}".`;
    }
    // A tool the server added since Sym last listed: list again first.
    if (!row.tools.some((tool) => tool.name === input.tool)) {
      const token = await connectionToken(sql, row);
      const listed = await relistTools(row.url, token?.token, row.tools, probeServer);
      if (listed.ok) row = (await saveTools(sql, row.id, listed.tools, listed.instructions)) ?? row;
    }
    const saved = await setToolMode(sql, row.id, input.tool, input.mode);
    if (!saved) return `"${input.name}" has no tool named "${input.tool}".`;
    return `Set "${input.tool}" on "${input.name}" to ${input.mode}. It applies from the next message.`;
  },
});
