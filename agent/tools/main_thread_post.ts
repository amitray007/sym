import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller } from "../../lib/callers.ts";
import { requesterResponse, slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { postToMainThread } from "../../lib/slack/main-thread.ts";
import { POST_MAX } from "../../lib/slack/post.ts";
import { hasBroadcastMention } from "../../lib/slack/slack-post.ts";

// Posts in the thread a code channel came from, when a person asks (decision 079). A code channel
// is the same agent as its thread, so it can still speak there. It shares the hourly post cap and
// the broadcast approval of slack_post (decision 082).
export default defineTool({
  description:
    "From a code channel, post a message in the main thread it came from. Use it only when a person asks, such as 'summarize this in the main thread' or 'let them know in the original thread'. Write the message in your voice for people who were not in the channel: what happened, the outcome, and links such as the PR. Never post there on your own. When the person also asks to close, post first, then call job_close.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(POST_MAX)
      .describe("The message to post in the main thread. A few short lines."),
  }),
  // A ping to a whole channel or group waits for the requester (decision 082).
  approval: {
    request: ({ toolInput }) =>
      hasBroadcastMention(toolInput?.text ?? "") ? "user-approval" : "not-applicable",
    response: requesterResponse("Only the person who asked can approve this post."),
    prompt: ({ input }) => `Post this in the main thread?\n\n${input.text}`,
  },
  async execute({ text }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return "Worker threads cannot post in Slack.";
    return postToMainThread(ledgerDeps(), {
      sessionId: ctx.session.id,
      callId: ctx.callId,
      requester: slackUserOfPrincipal(ctx.session.auth.current?.principalId),
      text,
    });
  },
});
