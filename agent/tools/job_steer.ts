import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { steerJob } from "../../lib/jobs/steer.ts";
import { withJobDeps } from "../../lib/runtime.ts";

// "Skip the staging test" in a job thread (docs/architecture.md, flow 5). The text goes to the
// worker thread as a steer. The same text sends once, even if the step re-runs.

export default defineTool({
  description:
    "Use when the person in a job thread asks to change course on a running worker job, for " +
    "example 'skip the staging test'. Pass the job reference and their instruction in plain " +
    "words. Reply with the one-line result.",
  inputSchema: z.object({
    job: z.string().describe("A job reference such as J-142."),
    text: z.string().min(1).describe("What the worker should do differently."),
  }),
  label: { start: ({ job }) => `Steer ${job}` },
  async execute({ job, text }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return withJobDeps((deps) => steerJob(deps, job, text, "steer", ctx.callId));
  },
});
