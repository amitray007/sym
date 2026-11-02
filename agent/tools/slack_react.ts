import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import {
  reactionTarget,
  reactToLinkedMessage,
  reactToTurn,
  unreactToTurn,
} from "../../lib/reactions/react.ts";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";

// A reaction on the message that started this turn (decision 051). Code enforces the limits:
// one reaction per message and three per thread per hour. The brain decides whether one fits.
// On request, it also adds or removes Sym's reaction on a linked message (decision 082).
export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "React to the message that started this turn with an emoji, like a person would. Use it " +
    "rarely, only on a clear trigger: something funny, a good idea, good news, or a short " +
    "thanks or ack that needs no text reply. Most messages get no reaction. Never use the eyes " +
    "emoji. Never use a laughing emoji on a failure or someone's mistake. Give the name " +
    "without colons, such as tada. Call slack_emoji first for a custom emoji. " +
    "When a person asks you to react to another message, pass its link as message. When they " +
    "ask you to take a reaction off, set remove to true.",
  inputSchema: z.object({
    emoji: z.string().min(1).max(100).describe("The emoji name, such as tada or white_check_mark."),
    message: z.string().max(500).optional().describe("A link to the message, only on request."),
    remove: z.boolean().optional().describe("True to take Sym's reaction off, only on request."),
  }),
  label: {
    start: ({ emoji, remove }) => `${remove ? "Remove" : "React"} :${emoji.replaceAll(":", "")}:`,
  },
  async execute({ emoji, message, remove }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const deps = {
      sql: ledger(),
      api: slackFromEnv(),
      messageTs: reactionTarget(ctx.session.id, ctx.session.turn.id),
    };
    if (message) {
      const requester = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
      return reactToLinkedMessage({ ...deps, pack: pack() }, requester, message, emoji, !remove);
    }
    if (remove) return unreactToTurn(deps, ctx.session.id, emoji);
    return reactToTurn(deps, ctx.session.id, emoji);
  },
});
