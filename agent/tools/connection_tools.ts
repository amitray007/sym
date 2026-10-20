import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { relistTools } from "../../lib/connections/add.ts";
import { connectionToken } from "../../lib/connections/auth.ts";
import { type ModeChoice, modePrompt } from "../../lib/connections/format.ts";
import { probeServer } from "../../lib/connections/probe.ts";
import {
  getConnection,
  saveTools,
  setDefaultMode,
  setToolMode,
} from "../../lib/connections/rows.ts";
import type { ToolMode } from "../../lib/connections/tools.ts";
import {
  mayDecideAsOwner,
  OWNER_ONLY,
  ownerResponse,
  slackUserOfPrincipal,
} from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The owner changes how a connection's tools run (decisions 045 and 049): auto, ask, or hidden,
// for one tool or, without a tool, for the connection default.
export default defineTool({
  description:
    "Change how an MCP connection's tools run, when the owner asks: auto runs without asking, " +
    "ask needs the owner's approval for every call, hidden removes it, default clears a mode. " +
    "Give a tool to change that tool. Leave tool out to change every tool on the connection " +
    "that has no mode of its own, including tools added later. The owner approves the change.",
  inputSchema: z.object({
    name: z.string().describe("The connection name."),
    tool: z
      .string()
      .optional()
      .describe("The tool name as connection_list shows it. Leave out for the whole connection."),
    mode: z.enum(["auto", "ask", "hidden", "default"] satisfies ModeChoice[]),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) => modePrompt(input.name, input.tool, input.mode),
  },
  label: { start: ({ name, tool }) => `Set ${name}${tool ? ` ${tool}` : ""}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const caller = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!mayDecideAsOwner(caller, pack())) return OWNER_ONLY;
    const sql = ledger();
    let row = await getConnection(sql, input.name);
    if (row?.status !== "active") {
      return `There is no active connection named "${input.name}".`;
    }
    const mode: ToolMode | null = input.mode === "default" ? null : input.mode;
    if (input.tool === undefined) {
      const saved = await setDefaultMode(sql, row.id, mode);
      if (!saved) return `There is no active connection named "${input.name}".`;
      return mode
        ? `Set the default mode of "${input.name}" to ${mode}. It covers every tool without its own mode, including tools added later. It applies from the next message.`
        : `Cleared the default mode of "${input.name}". Tools follow their read-only hints again. It applies from the next message.`;
    }
    // A tool the server added since Sym last listed: list again first.
    if (!row.tools.some((tool) => tool.name === input.tool)) {
      const token = await connectionToken(sql, row);
      const listed = await relistTools(row.url, token?.token, row.tools, probeServer);
      if (listed.ok) row = (await saveTools(sql, row.id, listed.tools, listed.instructions)) ?? row;
    }
    const saved = await setToolMode(sql, row.id, input.tool, mode);
    if (!saved) return `"${input.name}" has no tool named "${input.tool}".`;
    return mode
      ? `Set "${input.tool}" on "${input.name}" to ${mode}. It applies from the next message.`
      : `Cleared the own mode of "${input.tool}" on "${input.name}". It follows the connection default. It applies from the next message.`;
  },
});
