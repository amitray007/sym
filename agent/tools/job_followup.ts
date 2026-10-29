import { defineTool } from "eve/tools";
import { z } from "zod";
import { proposeFollowUp } from "../../lib/jobs/followup.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { pack, withJobDeps } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

export default defineTool({
  description:
    "Propose a specific follow-up on a finished job's worker thread and branch. Posts Start / Not now. Never starts work itself. Use for requested changes after discussing a result.",
  inputSchema: z.object({ ref: z.string(), change: z.string().trim().min(1).max(1000) }),
  async execute({ ref, change }, ctx) {
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by))
      return { posted: false, reason: "This needs an allowed person in Slack." };
    const result = await withJobDeps((deps) =>
      proposeFollowUp(deps, ref, change, `${ctx.session.id}:${ctx.callId}:followup`),
    );
    return { posted: Boolean(result.job), note: result.answer };
  },
});
