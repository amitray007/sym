import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { jobReply } from "../../lib/jobs/names.ts";
import { stopJob } from "../../lib/jobs/steer.ts";
import { getJobByRef } from "../../lib/ledger/jobs.ts";
import { mayDecideAsOwner, ownerResponse, slackUserOfPrincipal } from "../../lib/owner.ts";
import { pack, withJobDeps } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

// "Stop it" in a job thread (docs/architecture.md, flow 5). It interrupts the worker thread and
// ends the job as cancelled. Stopping loses the running turn, so the owner approves it. The
// approval prompt reads only the tool input, so the input repeats the title, and execute refuses
// when it differs from the stored job.

export default defineTool({
  description:
    "Use when the person in a job thread asks to stop a running worker job. Pass the job " +
    "reference and its exact title from jobs_status. Reply with the one-line result.",
  inputSchema: z.object({
    job: z.string().describe("A job reference such as J-142."),
    title: z.string().describe("The job's exact title, as jobs_status shows it."),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) =>
      `Stop "${input.title}"? I'll stop its current work. If it already finished, I'll keep its result.`,
  },
  label: { start: ({ title }) => `Stop ${title}` },
  async execute({ job, title }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (
      !isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by) ||
      !mayDecideAsOwner(by, pack())
    )
      return "Only the owner can stop a job.";
    return withJobDeps(async (deps) => {
      const found = await getJobByRef(deps.sql, job);
      if (found && found.title.trim() !== title.trim()) {
        return `The title shown doesn't match ${found.title}. Nothing was stopped.`;
      }
      return jobReply(deps.sql, job, ctx.session.id, await stopJob(deps, job));
    });
  },
});
