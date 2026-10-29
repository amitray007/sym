import { defineTool } from "eve/tools";
import { z } from "zod";
import { closeJob } from "../../lib/jobs/followup.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { pack, withJobDeps } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

export default defineTool({
  description:
    "Close a finished job when the person says they are done. Settles the worker thread, stops following its PR, and archives its code channel. Reports external success only after confirmation. Ask for clarification if the target or intent is unclear.",
  inputSchema: z.object({ ref: z.string() }),
  async execute({ ref }, ctx) {
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!by || !isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by))
      return { status: "refused", reason: "This needs an allowed person in Slack." };
    return withJobDeps((deps) => closeJob(deps, ref, by));
  },
});
