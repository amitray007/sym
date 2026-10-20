import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { removePrompt } from "../../lib/connections/format.ts";
import { disableConnection } from "../../lib/connections/rows.ts";
import {
  mayDecideAsOwner,
  OWNER_ONLY,
  ownerResponse,
  slackUserOfPrincipal,
} from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// Removes a connection (decision 045): the row turns disabled and its stored sign-in is deleted.
export default defineTool({
  description:
    "Remove an MCP connection when the owner asks. Sym stops loading it and deletes its " +
    "stored sign-in. The owner approves the removal.",
  inputSchema: z.object({ name: z.string().describe("The connection name.") }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) => removePrompt(input.name),
  },
  label: { start: ({ name }) => `Remove ${name}` },
  async execute({ name }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const caller = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!mayDecideAsOwner(caller, pack())) return OWNER_ONLY;
    const row = await disableConnection(ledger(), name);
    if (!row) return `There is no connection named "${name}".`;
    const envNote = row.envVar
      ? ` The owner can also delete ${row.envVar} from the deployment environment.`
      : "";
    return `Removed "${row.name}". It stops loading from the next message.${envNote}`;
  },
});
