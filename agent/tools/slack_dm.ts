import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { requesterOf, requesterResponse } from "../../lib/requester.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { dmNeedsConfirmation, sendDirectMessage } from "../../lib/slack/dm.ts";
import { POST_MAX } from "../../lib/slack/post.ts";
import { readInTurn } from "../../lib/slack/read.ts";

// Sends a person a DM when someone asks (decision 083). From a DM or private channel, the
// requester approves it first.
export default defineTool({
  description:
    "Send a person a direct message when someone asks, such as 'let <@U…> know it shipped'. " +
    "Pass their @-mention or user ID. Write the message in your own voice for that person, with " +
    "the context they need. Mention who asked only when asked to. Never DM anyone on your own.",
  inputSchema: z.object({
    person: z.string().min(1).max(100).describe("A Slack @-mention or user ID, such as <@U123>."),
    text: z.string().min(1).max(POST_MAX).describe("The message to send. A few short lines."),
  }),
  approval: {
    request: async ({ session, toolInput }) =>
      dmNeedsConfirmation(
        ledgerDeps(),
        session.id,
        await requesterOf(session, ledgerDeps),
        toolInput?.person,
      ).then((ask) => (ask || readInTurn(session) ? "user-approval" : "not-applicable")),
    response: requesterResponse("Only the person who asked can approve this DM.", ledgerDeps),
    prompt: ({ input }) => `Send this to ${input.person}?\n\n${input.text}`,
  },
  label: { start: () => "Send a DM" },
  async execute({ person, text }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return sendDirectMessage(ledgerDeps(), {
      sessionId: ctx.session.id,
      callId: ctx.callId,
      requester: await requesterOf(ctx.session, ledgerDeps),
      person,
      text,
    });
  },
});
