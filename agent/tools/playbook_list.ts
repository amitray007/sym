import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { playbookList } from "../../lib/learning/format.ts";
import { listPlaybooks } from "../../lib/learning/rows.ts";
import { ledger } from "../../lib/runtime.ts";

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "List playbooks and rules with their bodies, newest first. Filter by status to see only " +
    "proposals or only approved rows.",
  inputSchema: z.object({
    status: z.enum(["proposed", "approved", "rejected", "retired"]).optional(),
  }),
  label: { start: () => "List playbooks" },
  async execute({ status }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return playbookList(await listPlaybooks(ledger(), status));
  },
});
