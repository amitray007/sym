import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { pack, slackFromEnv } from "../../lib/runtime.ts";
import { pinMessage } from "../../lib/slack/pins.ts";

// Pins or unpins a linked message when a person asks (decision 084).
export default defineTool({
  description:
    "Pin a Slack message to its channel when a person asks, or unpin it with remove set to " +
    "true. Pass the message link. Never pin on your own.",
  inputSchema: z.object({
    message: z.string().min(1).max(500).describe("A link to the message."),
    remove: z.boolean().optional().describe("True to unpin."),
  }),
  label: { start: ({ remove }) => (remove ? "Unpin a message" : "Pin a message") },
  async execute({ message, remove }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return pinMessage(
      { slack: slackFromEnv(), pack: pack() },
      slackUserOfPrincipal(ctx.session.auth.current?.principalId),
      message,
      !remove,
    );
  },
});
