import { defineTool } from "eve/tools";
import { z } from "zod";
import { checkJob } from "../../lib/jobs/run.ts";
import { freshJobStatus, jobListAnswer } from "../../lib/jobs/status.ts";
import { recentJobs } from "../../lib/ledger/jobs.ts";
import { ledger, withJobDeps } from "../../lib/runtime.ts";

// "What's the update?" (docs/architecture.md, flow 5). The ledger answers; for one running job,
// one fresh worker read first, so the answer is current.

export default defineTool({
  description:
    "Status of worker jobs. Pass a job reference such as J-142 for one job, or nothing for all " +
    "active jobs and the jobs that finished today. Answer in 2 or 3 short lines.",
  inputSchema: z.object({
    job: z.string().optional().describe("A job reference such as J-142."),
  }),
  label: { start: ({ job }) => (job ? `Check ${job}` : "Check jobs") },
  async execute({ job: ref }) {
    const sql = ledger();
    const now = new Date();
    if (!ref) {
      const today = new Date(now);
      today.setUTCHours(0, 0, 0, 0);
      return jobListAnswer(await recentJobs(sql, today), now);
    }
    return (
      (await freshJobStatus(sql, ref, now, (jobId) =>
        withJobDeps((deps) => checkJob(deps, jobId, 1_000)),
      )) ?? { status: "not_found", job: ref }
    );
  },
});
