import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { planConnection } from "../../lib/connections/add.ts";
import { reviewOf } from "../../lib/connections/format.ts";
import { nameProblem } from "../../lib/connections/names.ts";
import { probeServer } from "../../lib/connections/probe.ts";
import { getConnection, proposeConnection } from "../../lib/connections/rows.ts";
import { mayDecideAsOwner, OWNER_ONLY, slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The first half of adding an MCP connection (decision 045). Sym probes the server and saves a
// proposal. Nothing loads until the owner approves it with connection_approve. The input has no
// token field on purpose: tokens live in the deployment environment or come from a sign-in.
export default defineTool({
  description:
    "Connect an MCP server when the owner asks. Give a short name and the server's URL. Sym " +
    "checks the server and saves a proposal. Then call connection_approve with the review in " +
    "the result, so the owner can approve it. Never ask anyone for a token or a password.",
  inputSchema: z
    .object({
      name: z
        .string()
        .describe("Lowercase letters, digits, and single dashes, such as example-tracker."),
      url: z.string().describe("The server's MCP URL, https unless it is on this machine."),
      description: z
        .string()
        .max(300)
        .optional()
        .describe("What the service is for, in a few words."),
    })
    .strict(),
  label: { start: ({ name }) => `Check ${name}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const caller = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!mayDecideAsOwner(caller, pack())) return OWNER_ONLY;
    const name = input.name.trim();
    const problem = nameProblem(name);
    if (problem) return problem;
    const sql = ledger();
    const existing = await getConnection(sql, name);
    if (existing?.status === "active") {
      return `"${name}" is already connected. Remove it first to connect it again.`;
    }
    const plan = await planConnection(
      { ...input, createdBy: caller ?? null },
      { env: process.env, probe: probeServer },
    );
    if (!plan.ok) return plan.reason;
    const saved = await proposeConnection(sql, plan.connection);
    if (!saved.ok) return saved.reason;
    return [
      `Proposed "${saved.row.name}". Call connection_approve with this review:`,
      JSON.stringify(reviewOf(saved.row)),
      ...plan.notes,
    ].join("\n");
  },
});
