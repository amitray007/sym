import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { stopJob } from "../../lib/jobs/steer.ts";
import { mayDecideAsOwner, ownerResponse, slackUserOfPrincipal } from "../../lib/owner.ts";
import { pack, withJobDeps } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

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
    prompt: ({ input }) =>
      `Stop ${input.job}? I'll stop its current work. If it already finished, I'll keep its result.`,
  },
  label: { start: ({ job }) => `Stop ${job}` },
  async execute({ job }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (
      !isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by) ||
      !mayDecideAsOwner(by, pack())
    )
      return "Only the owner can stop a job.";
    return withJobDeps((deps) => stopJob(deps, job));
  },
});
