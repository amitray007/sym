import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { jobIdOfThread } from "../../lib/feedback/feedback.ts";
import { getJob, getJobByRef } from "../../lib/ledger/jobs.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { codeChannelsOn, jobOfCodeChannel } from "../../lib/slack/code-channel.ts";
import { inviteToCodeChannel, normalizeSlackPerson } from "../../lib/slack/code-channel-invite.ts";

export default defineDynamic((ctx) => {
  if (!codeChannelsOn() || isWorkerCaller(ctx.session.auth.current)) return null;
  return defineTool({
    description:
      "Invite people into the work's code channel only when the person asks to bring someone in. " +
      "Never invite on your own. If they name someone without an @-mention, ask them to @-mention " +
      "the person. Call once per request and report each person's result, naming the work by title " +
      "or 'this', never its job reference. Omit job to use this conversation's work.",
    inputSchema: z.object({
      job: z.string().optional().describe("An optional job reference, such as J-142."),
      people: z
        .array(
          z
            .string()
            .transform(normalizeSlackPerson)
            .pipe(z.string().regex(/^[UW][A-Z0-9]+$/)),
        )
        .min(1)
        .max(10)
        .describe("Slack user IDs from the requested @-mentions, such as <@U123> or U123."),
    }),
    async execute({ job: ref, people }, toolCtx) {
      if (isWorkerCaller(toolCtx.session.auth.current)) return NOT_FOR_WORKERS;
      const deps = ledgerDeps();
      const thread = await getSessionThread(deps.sql, toolCtx.session.id);
      let job = ref ? await getJobByRef(deps.sql, ref) : undefined;
      if (!ref && thread) {
        job = await jobOfCodeChannel(deps.sql, thread.channelId);
        if (!job && thread.threadTs) {
          const id = await jobIdOfThread(deps.sql, thread.channelId, thread.threadTs);
          job = id ? await getJob(deps.sql, id) : undefined;
        }
      }
      return inviteToCodeChannel(
        deps,
        job,
        people,
        slackUserOfPrincipal(toolCtx.session.auth.current?.principalId),
      );
    },
  });
});
