import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { requesterOf } from "../../lib/requester.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { deleteOwnPost } from "../../lib/slack/own-posts.ts";

// Deletes a post Sym made because this person asked (decision 082). Only they can delete it.
export default defineTool({
  description:
    "Delete a message you posted because this person asked, when they ask you to remove it. " +
    "Pass the message link, or leave it out for your latest post for them in this conversation. " +
    "You can only delete your own posts made for this person.",
  inputSchema: z.object({
    message: z.string().max(500).optional().describe("A link to the post to delete."),
  }),
  label: { start: () => "Delete a post" },
  async execute({ message }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return deleteOwnPost(ledgerDeps(), {
      sessionId: ctx.session.id,
      callId: ctx.callId,
      requester: await requesterOf(ctx.session, ledgerDeps),
      message,
    });
  },
});
