import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { requesterResponse, slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { POST_MAX } from "../../lib/slack/post.ts";
import { readInTurn } from "../../lib/slack/read.ts";
import { postNeedsConfirmation, postToConversation } from "../../lib/slack/slack-post.ts";

// Posts in another Slack channel or thread when a person asks (decision 081). Code checks the
// allow-list and both memberships; a post out of a private conversation waits for the
// requester's confirmation.
export default defineTool({
  description:
    "Post a message in another Slack channel or thread when a person asks, such as 'post this in " +
    "#releases' or 'tell them in this thread: <link>'. Pass the target as the person gave it: a " +
    "message or thread link, a #channel, or a channel mention. A message link posts in that " +
    "message's thread; a channel posts at the top level. Write the message for the people in " +
    "that channel, in your own voice. Mention the person who asked (<@their user ID>) only when " +
    "they ask you to. Never post on your own. Use main_thread_post for a code channel's main thread. " +
    "If the tool says it can't reach the conversation, say so in one line and do not guess why.",
  inputSchema: z.object({
    target: z.string().min(1).max(500).describe("A Slack link, #channel, or channel mention."),
    text: z.string().min(1).max(POST_MAX).describe("The message to post. A few short lines."),
  }),
  approval: {
    request: ({ session, toolInput }) =>
      postNeedsConfirmation(ledgerDeps(), session.id, toolInput?.target, toolInput?.text).then(
        (ask) => (ask || readInTurn(session) ? "user-approval" : "not-applicable"),
      ),
    response: requesterResponse("Only the person who asked can approve this post."),
    prompt: ({ input }) => `Post this in ${input.target}?\n\n${input.text}`,
  },
  label: { start: () => "Post in Slack" },
  async execute({ target, text }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return postToConversation(ledgerDeps(), {
      sessionId: ctx.session.id,
      callId: ctx.callId,
      requester: slackUserOfPrincipal(ctx.session.auth.current?.principalId),
      target,
      text,
    });
  },
});
