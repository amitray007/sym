import { z } from "zod";

// The trigger_create tool input (decision 088).
export const TriggerInput = z.object({
  title: z.string().min(3).max(80).describe("Short name, for example 'Bug report triage'."),
  instruction: z
    .string()
    .min(3)
    .max(4000)
    .describe(
      "What to do when the event happens, in plain words, with the exact facts: projects, " +
        "channels, people, links. Each run reads only this text and the event.",
    ),
  on: z
    .enum(["message", "reaction"])
    .describe(
      "'message': a new top-level message in the channel. 'reaction': someone adds the emoji " +
        "to a message in the channel.",
    ),
  channel: z
    .string()
    .optional()
    .describe("The channel to watch: an ID, mention, link, or #name. Default: this channel."),
  keywords: z
    .array(z.string().min(1).max(40))
    .max(10)
    .default([])
    .describe(
      "For 'message' only: fire only when the message has one of these words. The run still " +
        "decides relevance from the instruction. Empty: every new message.",
    ),
  emoji: z
    .string()
    .max(100)
    .optional()
    .describe("For 'reaction' only: the emoji name, such as 'eyes' or ':ticket:'."),
  builder: z
    .enum(["ask", "auto"])
    .default("ask")
    .describe(
      "If a run starts Builder work: 'auto' starts it without a click, 'ask' posts Start / " +
        "Not now. Use the person's answer; default 'ask'.",
    ),
  destination: z
    .string()
    .optional()
    .describe(
      "Where runs post: 'thread' (default) for the event message's thread, 'dm' for a DM with " +
        "the person who set it up, or a channel ID, mention, or link.",
    ),
});
export type TriggerInput = z.infer<typeof TriggerInput>;
