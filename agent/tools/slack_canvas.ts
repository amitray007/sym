import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { requesterResponse, slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledger, ledgerDeps, pack, slackFromEnv } from "../../lib/runtime.ts";
import { CANVAS_MAX, writeChannelCanvas } from "../../lib/slack/canvas.ts";
import { postNeedsConfirmation } from "../../lib/slack/slack-post.ts";

// Writes to a channel's canvas when a person asks (decision 084). Sym adds to the end of an
// existing canvas and never replaces what people wrote.
export default defineTool({
  description:
    "Write to a Slack channel's canvas when a person asks, such as 'put this runbook in the " +
    "#ops canvas'. Pass the channel and Markdown. If the channel has a canvas, the text goes at " +
    "its end; otherwise Sym creates one with the title. Never write a canvas on your own.",
  inputSchema: z.object({
    target: z.string().min(1).max(500).describe("A #channel, channel mention, or channel link."),
    markdown: z.string().min(1).max(CANVAS_MAX).describe("The Markdown to add."),
    title: z.string().max(100).optional().describe("A title, used only for a new canvas."),
  }),
  approval: {
    request: ({ session, toolInput }) =>
      postNeedsConfirmation(ledgerDeps(), session.id, toolInput?.target, toolInput?.markdown).then(
        (ask) => (ask ? "user-approval" : "not-applicable"),
      ),
    response: requesterResponse("Only the person who asked can approve this canvas."),
    prompt: ({ input }) => `Add this to the ${input.target} canvas?\n\n${input.markdown}`,
  },
  label: { start: () => "Write a canvas" },
  async execute({ target, markdown, title }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return writeChannelCanvas(
      { sql: ledger(), slack: slackFromEnv(), pack: pack() },
      {
        sessionId: ctx.session.id,
        callId: ctx.callId,
        requester: slackUserOfPrincipal(ctx.session.auth.current?.principalId),
        target,
        markdown,
        title,
      },
    );
  },
});
