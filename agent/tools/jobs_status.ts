import { defineTool } from "eve/tools";
import { z } from "zod";
import { checkJob } from "../../lib/jobs/run.ts";
import { freshJobStatus, jobListAnswer } from "../../lib/jobs/status.ts";
import { jobRef, recentJobs } from "../../lib/ledger/jobs.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledger, pack, withJobDeps } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

// "What's the update?" (docs/architecture.md, flow 5). The ledger answers; for one running job,
// one fresh worker read first, so the answer is current.

export default defineTool({
  description:
    "Status of worker jobs. Pass a job reference such as J-142 for one job, or nothing for all " +
    "active jobs and the jobs that finished today. Answer in 2 or 3 short lines.",
  inputSchema: z.object({
    job: z.string().optional().describe("A job reference such as J-142."),
  }),
  label: { start: () => "Check work" },
  async execute({ job: ref }, ctx) {
    const sql = ledger();
    const now = new Date();
    if (!ref) {
      const today = new Date(now);
      today.setUTCHours(0, 0, 0, 0);
      const jobs = await recentJobs(sql, today);
      return {
        answer: jobListAnswer(jobs, now),
        jobs: jobs.map((job) => ({ job: jobRef(job.id), title: job.title, status: job.status })),
      };
    }
    const status = await freshJobStatus(
      sql,
      ref,
      now,
      (jobId) => withJobDeps((deps) => checkJob(deps, jobId, 1_000)),
      (await getSessionThread(sql, ctx.session.id)) ?? undefined,
    );
    if (!status) return { status: "not_found", job: ref };
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (by && isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by)) return status;
    // Shared status readers keep their existing summary access. Full briefs belong to the
    // allowed Slack conversation and can contain instructions outside that read capability.
    const { brief: _brief, ...summary } = status;
    return summary;
  },
});
