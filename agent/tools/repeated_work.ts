import { isScheduleAuth } from "eve/schedules";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { briefsText, recentBriefs } from "../../lib/learning/repeat.ts";
import { listPlaybooks } from "../../lib/learning/rows.ts";
import { jobRef } from "../../lib/ledger/jobs.ts";
import { mayDecideAsOwner, OWNER_ONLY, slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// Repeated work, step 1 (decision 058): the briefs of recent finished jobs, for the brain to
// read. The weekly `repeat` schedule calls it as the app principal; the owner can ask for it too.
export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Read the briefs of recent finished jobs to find work people ask for again and again. Use " +
    "it for the weekly repeated-work review, or when the owner asks what work keeps coming back. " +
    "Then propose a playbook for each real pattern with repeated_work_propose.",
  inputSchema: z.object({}),
  label: { start: () => "Read recent jobs" },
  async execute(_input, ctx) {
    const caller = ctx.session.auth.current;
    if (isWorkerCaller(caller)) return NOT_FOR_WORKERS;
    if (
      !isScheduleAuth(caller) &&
      !mayDecideAsOwner(slackUserOfPrincipal(caller?.principalId), pack())
    ) {
      return OWNER_ONLY;
    }
    const sql = ledger();
    const now = new Date();
    const [briefs, proposed, approved] = await Promise.all([
      recentBriefs(sql, now),
      listPlaybooks(sql, "proposed"),
      listPlaybooks(sql, "approved"),
    ]);
    return {
      answer: briefsText(briefs, [...approved, ...proposed]),
      jobs: briefs.map((brief) => ({ ...brief, ref: jobRef(brief.id) })),
    };
  },
});
