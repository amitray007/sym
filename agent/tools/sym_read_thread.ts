import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, WORKER_ONLY } from "../../lib/callers.ts";
import { readJobThread } from "../../lib/jobs/worker-calls.ts";
import { ledgerDeps } from "../../lib/runtime.ts";

// Called by a worker thread through the MCP channel (agent/channels/mcp.ts). Hidden from the
// brain's own tool list. Decision 075.
export default defineTool({
  deferred: true,
  description:
    "For worker threads only, never the Slack brain. Read the Slack thread your Sym job came " +
    "from, when the brief leaves out a detail such as an ID, a URL, or what a screenshot shows.",
  inputSchema: z.object({
    job: z.string().max(40).describe("Your job reference, such as J-142."),
  }),
  async execute(input, ctx) {
    if (!isWorkerCaller(ctx.session.auth.current)) return WORKER_ONLY;
    const result = await readJobThread(ledgerDeps(), input, ctx.session.auth.current);
    return result.message;
  },
});
