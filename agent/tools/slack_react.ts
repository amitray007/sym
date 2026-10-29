import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { reactToTurn } from "../../lib/reactions/react.ts";
import { ledger, slackFromEnv } from "../../lib/runtime.ts";

// A reaction on the message that started this turn (decision 051). Code enforces the limits:
// one reaction per message and three per thread per hour. The brain decides whether one fits.
export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "React to the message that started this turn with an emoji, like a person would. Use it " +
    "rarely, only on a clear trigger: something funny, a good idea, good news, or a short " +
    "thanks or ack that needs no text reply. Most messages get no reaction. Never use the eyes " +
    "emoji. Never use a laughing emoji on a failure or someone's mistake. Give the name " +
    "without colons, such as tada. Call slack_emoji first for a custom emoji.",
  inputSchema: z.object({
    emoji: z.string().min(1).max(100).describe("The emoji name, such as tada or white_check_mark."),
  }),
  label: { start: ({ emoji }) => `React :${emoji.replaceAll(":", "")}:` },
  async execute({ emoji }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return reactToTurn({ sql: ledger(), api: slackFromEnv() }, ctx.session.id, emoji);
  },
});
