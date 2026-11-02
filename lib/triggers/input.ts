import { z } from "zod";

// The trigger_create tool input (decisions 088 and 090).
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
    .enum(["message", "reaction", "webhook"])
    .describe(
      "'message': a new top-level message in the channel. 'reaction': someone adds the emoji " +
        "to a message in the channel. 'webhook': a signed HTTP request to the trigger's own " +
        "URL; Sym DMs the person the URL and secret.",
    ),
  channel: z
    .string()
    .optional()
    .describe(
      "For 'message' and 'reaction': the channel to watch, as an ID, mention, link, or #name. " +
        "Default: this channel.",
    ),
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
        "the person who set it up, or a channel ID, mention, or link. A webhook has no event " +
        "thread: its default is this conversation, and each run starts a new thread.",
    ),
});
export type TriggerInput = z.infer<typeof TriggerInput>;
