import { defineTool } from "eve/tools";
import { z } from "zod";
import { approvalMode } from "../../lib/approvals.ts";
import { proposeFollowUp, startFollowUp } from "../../lib/jobs/followup.ts";
import { jobReply } from "../../lib/jobs/names.ts";
import { jobRef } from "../../lib/ledger/jobs.ts";
import { requesterOf } from "../../lib/requester.ts";
import { ledger, ledgerDeps, pack, withJobDeps } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

export default defineTool({
  description:
    "Propose a specific follow-up on a finished job's worker thread and branch. Posts Start / Not now, or starts it at once when this deployment skips the Start click. Use for requested changes after discussing a result.",
  inputSchema: z.object({ ref: z.string(), change: z.string().trim().min(1).max(1000) }),
  async execute({ ref, change }, ctx) {
    const by = await requesterOf(ctx.session, ledgerDeps);
    if (!isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by))
      return { posted: false, reason: "This needs an allowed person in Slack." };
    const key = `${ctx.session.id}:${ctx.callId}:followup`;
    // `SYM_APPROVAL_START=never` (decision 099) starts it now, through the same checks as Start.
    const result = await withJobDeps((deps) =>
      approvalMode("start") === "never" && by
        ? startFollowUp(deps, ref, change, by, key)
        : proposeFollowUp(deps, ref, change, key),
    );
    return {
      posted: Boolean(result.job),
      ...(result.job ? { job: jobRef(result.job.id) } : {}),
      note: result.job
        ? result.answer
        : await jobReply(ledger(), ref, ctx.session.id, result.answer),
    };
  },
});
