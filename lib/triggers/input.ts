import { z } from "zod";

// The trigger_create tool input (decisions 088, 090, and 091).
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
    .enum(["message", "reaction", "webhook", "github", "linear"])
    .describe(
      "'message': a new top-level message in the channel. 'reaction': someone adds the emoji " +
        "to a message in the channel. 'webhook': a signed HTTP request to the trigger's own " +
        "URL; Sym DMs the person the URL and secret. 'github': an event in one repository " +
        "where the GitHub App is installed. 'linear': a Linear issue created or changed.",
    ),
  repository: z
    .string()
    .max(200)
    .optional()
    .describe("For 'github' only: the repository as owner/name."),
  events: z
    .array(z.enum(["pull_request", "issues", "check_suite", "issue_comment"]))
    .max(4)
    .default([])
    .describe("For 'github' only: which events fire it. Empty: all four."),
  actions: z
    .array(z.string().min(1).max(40))
    .max(10)
    .default([])
    .describe(
      "For 'github' and 'linear': which actions fire it, such as 'opened' or 'completed' on " +
        "GitHub, or 'create' or 'update' on Linear. Empty: any.",
    ),
  label: z
    .string()
    .max(100)
    .optional()
    .describe("For 'github' and 'linear': fire only for items with this label."),
  branch: z
    .string()
    .max(200)
    .optional()
    .describe(
      "For 'github' only: a pull request's base branch, or a check suite's branch, such as " +
        "'main'.",
    ),
  team: z
    .string()
    .max(20)
    .optional()
    .describe("For 'linear' only: the team key, such as 'ENG'. Empty: every team."),
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
        "the person who set it up, or a channel ID, mention, or link. A webhook, GitHub, or " +
        "Linear trigger has no event thread: its default is this conversation, and each run " +
        "starts a new thread.",
    ),
});
export type TriggerInput = z.infer<typeof TriggerInput>;
