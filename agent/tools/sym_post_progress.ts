import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, WORKER_ONLY } from "../../lib/callers.ts";
import { postProgress, SUMMARY_MAX } from "../../lib/jobs/worker-calls.ts";
import { ledgerDeps } from "../../lib/runtime.ts";

// Called by a worker thread through the MCP channel (agent/channels/mcp.ts). Hidden from the
// brain's own tool list.
export default defineTool({
  deferred: true,
  description:
    "For worker threads only, never the Slack brain. Report a one-line progress update for your " +
    "Sym job. Use the job reference from your first message, such as J-142.",
  inputSchema: z.object({
    job: z.string().max(40).describe("Your job reference, such as J-142."),
    skipping: z
      .string()
      .max(1000)
      .optional()
      .describe("What you are leaving alone, when relevant."),
    summary: z
      .string()
      .max(4000)
      .describe(`What you just did, in one line (max ${SUMMARY_MAX} characters).`),
  }),
  async execute(input, ctx) {
    if (!isWorkerCaller(ctx.session.auth.current)) return WORKER_ONLY;
    const result = await postProgress(ledgerDeps(), input, ctx.session.auth.current);
    return result.message;
  },
});
