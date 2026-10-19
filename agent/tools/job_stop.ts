import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { stopJob } from "../../lib/jobs/steer.ts";
import { ownerResponse } from "../../lib/owner.ts";
import { pack, withJobDeps } from "../../lib/runtime.ts";

// "Stop it" in a job thread (docs/architecture.md, flow 5). It interrupts the worker thread and
// ends the job as cancelled. Stopping loses the running turn, so the owner approves it.

export default defineTool({
  description:
    "Use when the person in a job thread asks to stop a running worker job. Pass the job " +
    "reference. Reply with the one-line result.",
  inputSchema: z.object({
    job: z.string().describe("A job reference such as J-142."),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) => `Stop ${input.job}? The worker stops and the job ends as cancelled.`,
  },
  label: { start: ({ job }) => `Stop ${job}` },
  async execute({ job }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return withJobDeps((deps) => stopJob(deps, job));
  },
});
