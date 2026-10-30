import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { jobReply } from "../../lib/jobs/names.ts";
import { steerJob } from "../../lib/jobs/steer.ts";
import { withJobDeps } from "../../lib/runtime.ts";

// "Skip the staging test" in a job thread (docs/architecture.md, flow 5). The text goes to the
// worker thread as a steer. The same text sends once, even if the step re-runs.

export default defineTool({
  description:
    "Use when the person in a job thread asks to change course on a running worker job, for " +
    "example 'skip the staging test'. Pass the job reference and their instruction in plain " +
    "words. If this answers a pending worker question, it passes the answer instead of steering. " +
    "For a question with several parts, pass requestId and answers keyed by the exact question IDs.",
  inputSchema: z.object({
    job: z.string().describe("A job reference such as J-142."),
    requestId: z.string().optional(),
    answers: z.record(z.string(), z.string()).optional(),
    text: z.string().min(1).describe("What the worker should do differently."),
  }),
  label: { start: () => "Pass on your direction" },
  async execute({ job, text, requestId, answers }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return withJobDeps(async (deps) =>
      jobReply(
        deps.sql,
        job,
        ctx.session.id,
        await steerJob(deps, job, text, "steer", `${ctx.session.id}:${ctx.callId}`, {
          requestId,
          answers,
        }),
      ),
    );
  },
});
