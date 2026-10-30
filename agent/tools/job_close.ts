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
    "Close finished work or this code channel when the person says they are done. Omit ref to close this conversation's code channel. Settles a job's worker thread, stops following its PR, and archives its code channel. Reports external success only after confirmation. Ask for clarification if the target or intent is unclear. " +
    "When the person also asks to share a summary or the result in the original or main thread, pass `summary` in the same call: Sym posts it there before it archives the channel. Do not post the summary in the code channel instead.",
  inputSchema: z.object({
    ref: z.string().optional(),
    summary: z
      .string()
      .max(3000)
      .optional()
      .describe(
        "Only when the person asks for it: the summary to post in the thread the work was asked in. Write it in your voice, for people who were not in the channel: what was found or done, the outcome, and links such as the PR. A few short lines.",
      ),
  }),
  async execute({ ref, summary }, ctx) {
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!by || !isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by))
      return { status: "refused", reason: "This needs an allowed person in Slack." };
    if (!ref) {
      const deps = ledgerDeps();
      const thread = await getSessionThread(deps.sql, ctx.session.id);
      if (!thread) return "I couldn't find this conversation's code channel.";
      return closeCodeChannel(
        {
          ...deps,
          closeJob: (job, user, options) => withJobDeps((d) => closeJob(d, job, user, options)),
        },
        thread.channelId,
        by,
        summary ? { summary } : {},
      );
    }
    return withJobDeps(async (deps) =>
      jobReply(
        deps.sql,
        ref,
        ctx.session.id,
        await closeJob(deps, ref, by, summary ? { summary } : {}),
      ),
    );
  },
});
