import { defineTool } from "eve/tools";
import { z } from "zod";
import { closeJob } from "../../lib/jobs/followup.ts";
import { jobReply } from "../../lib/jobs/names.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledgerDeps, pack, withJobDeps } from "../../lib/runtime.ts";
import { closeCodeChannel } from "../../lib/slack/code-channel-close.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

export default defineTool({
  description:
    "Close finished work or this code channel when the person says they are done. Omit ref to close this conversation's code channel. Settles a job's worker thread, stops following its PR, and archives its code channel. Reports external success only after confirmation. Ask for clarification if the target or intent is unclear.",
  inputSchema: z.object({ ref: z.string().optional() }),
  async execute({ ref }, ctx) {
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!by || !isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by))
      return { status: "refused", reason: "This needs an allowed person in Slack." };
    if (!ref) {
      const deps = ledgerDeps();
      const thread = await getSessionThread(deps.sql, ctx.session.id);
      if (!thread) return "I couldn't find this conversation's code channel.";
      return closeCodeChannel(
        { ...deps, closeJob: (job, user) => withJobDeps((d) => closeJob(d, job, user)) },
        thread.channelId,
        by,
      );
    }
    return withJobDeps(async (deps) =>
      jobReply(deps.sql, ref, ctx.session.id, await closeJob(deps, ref, by)),
    );
  },
});
