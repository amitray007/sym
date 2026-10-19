import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, WORKER_ONLY } from "../../lib/callers.ts";
import { askOwner, QUESTION_MAX } from "../../lib/jobs/worker-calls.ts";
import { ledgerDeps } from "../../lib/runtime.ts";

// Called by a worker thread through the MCP channel (agent/channels/mcp.ts). Hidden from the
// brain's own tool list.
export default defineTool({
  deferred: true,
  description:
    "For worker threads only, never the Slack brain. Ask the job owner one question in the Slack " +
    "thread when you are blocked. Ask once, then stop and wait for the reply.",
  inputSchema: z.object({
    job: z.string().max(40).describe("Your job reference, such as J-142."),
    question: z.string().max(4000).describe(`One clear question (max ${QUESTION_MAX} characters).`),
  }),
  async execute(input, ctx) {
    if (!isWorkerCaller(ctx.session.auth.current)) return WORKER_ONLY;
    const result = await askOwner(ledgerDeps(), input);
    return result.message;
  },
});
