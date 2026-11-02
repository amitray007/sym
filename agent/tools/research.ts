import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";

export default defineWorkflowTool({
  description:
    "Investigate several sources with a read-only researcher and return concise evidence. " +
    "Include the question, relevant facts, allowed project names, and requested Slack targets. " +
    "It has no conversation history, write tools, connections, or Builder access. " +
    "Runs as a task; independent calls can work in parallel.",
  inputSchema: z.object({ message: z.string().min(1).max(20_000) }),
  label: { start: () => "Research" },
  async task({ message }, ctx) {
    "use workflow";
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const response = await ctx.agent("researcher").send(message, { signal: ctx.abortSignal });
    const result = await response.result();
    return result.status === "completed"
      ? { answer: result.reply }
      : { status: result.status, note: "Research did not finish. No findings are confirmed." };
  },
});
