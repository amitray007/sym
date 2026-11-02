import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { requesterOf, requesterResponse } from "../../lib/requester.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { editOwnPost } from "../../lib/slack/own-posts.ts";
import { POST_MAX } from "../../lib/slack/post.ts";
import { editNeedsConfirmation } from "../../lib/slack/slack-post.ts";
import { readUntrustedInTurn } from "../../lib/triggers/untrusted.ts";

// Edits a post Sym made because this person asked (decision 082). Only they can edit it.
export default defineTool({
  description:
    "Edit a message you posted because this person asked, when they ask you to change it. Pass " +
    "the message link, or leave it out for your latest post for them in this conversation. Pass " +
    "the full new text. You can only edit your own posts made for this person.",
  inputSchema: z.object({
    message: z.string().max(500).optional().describe("A link to the post to edit."),
    text: z.string().min(1).max(POST_MAX).describe("The full new text of the message."),
  }),
  approval: {
    request: async ({ session, toolInput }) =>
      editNeedsConfirmation(
        ledgerDeps(),
        session.id,
        await requesterOf(session, ledgerDeps),
        toolInput?.message,
        toolInput?.text,
      ).then(async (ask) =>
        ask || (await readUntrustedInTurn(session, () => ledgerDeps().sql))
          ? "user-approval"
          : "not-applicable",
      ),
    response: requesterResponse("Only the person who asked can approve this edit.", ledgerDeps),
    prompt: ({ input }) => `Change the post to this?\n\n${input.text}`,
  },
  label: { start: () => "Edit a post" },
  async execute({ message, text }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return editOwnPost(ledgerDeps(), {
      sessionId: ctx.session.id,
      callId: ctx.callId,
      requester: await requesterOf(ctx.session, ledgerDeps),
      message,
      text,
    });
  },
});
