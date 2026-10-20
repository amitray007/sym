import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { approvalPrompt, reviewOf, sameReview } from "../../lib/connections/format.ts";
import { hasTokenEnv, tokenEnvVar } from "../../lib/connections/names.ts";
import { activateConnection, getConnection } from "../../lib/connections/rows.ts";
import {
  mayDecideAsOwner,
  OWNER_ONLY,
  ownerResponse,
  ownerUserId,
  slackUserOfPrincipal,
} from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The second half of adding a connection (decision 045). Eve's approval prompt can read only
// the tool input, so the input repeats the review from connection_add, and execute refuses it
// when it differs from the stored proposal. The owner approves exactly what loads.
export default defineTool({
  description:
    "Ask the owner to approve a proposed MCP connection. Pass the review from connection_add " +
    "unchanged. Approval makes the connection's tools available from the next message.",
  inputSchema: z.object({
    name: z.string(),
    url: z.string(),
    auth: z.enum(["none", "env", "oauth"]),
    tools: z.array(z.object({ name: z.string(), access: z.enum(["read", "write"]) })).max(100),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) =>
      approvalPrompt(input, input.auth === "env" ? tokenEnvVar(input.name) : null),
  },
  label: { start: ({ name }) => `Approve ${name}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const caller = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!mayDecideAsOwner(caller, pack())) return OWNER_ONLY;
    const sql = ledger();
    const row = await getConnection(sql, input.name);
    if (row?.status !== "proposed") {
      return `There is no proposal named "${input.name}". Call connection_add first.`;
    }
    if (!sameReview(reviewOf(row), input)) {
      return `The review differs from the proposal for "${row.name}". Nothing was approved.`;
    }
    const approver = ownerUserId(pack()) ?? caller ?? null;
    const active = await activateConnection(sql, row.id, approver, new Date());
    if (!active) return `"${row.name}" was not approved.`;
    if (active.authKind === "env" && !hasTokenEnv(active.envVar)) {
      return (
        `Approved "${active.name}". It loads once ${active.envVar} is set in the deployment ` +
        "environment and Sym is redeployed. Tell the owner the variable name. Never ask for the token."
      );
    }
    if (active.authKind === "oauth") {
      return `Approved "${active.name}". Now call connection_sign_in so the owner can sign in.`;
    }
    return `Approved "${active.name}". Its tools are available from the next message.`;
  },
});
