import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../../../lib/callers.ts";
import { jobStatusList } from "../../../../lib/jobs/status.ts";
import { getJobByRef, recentJobs } from "../../../../lib/ledger/jobs.ts";
import { ledger } from "../../../../lib/runtime.ts";

export default defineTool({
  description: "Read saved job status from the ledger. Does not refresh workers or post updates.",
  inputSchema: z.object({ job: z.string().optional() }),
  async execute({ job }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const sql = ledger();
    const now = new Date();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const found = job ? await getJobByRef(sql, job) : undefined;
    const jobs = job ? (found ? [found] : []) : await recentJobs(sql, today);
    return {
      source: "ledger",
      ...jobStatusList(jobs, now),
      ...(job && !found ? { answer: "Job not found." } : {}),
    };
  },
});
