import { parseQuietArg, type QuietArg } from "./quiet.ts";

// The text after `/sym` (docs/slack.md). Pure, so tests cover it without Slack.

export type SymCommand =
  | { type: "status" }
  | { type: "schedules" }
  | { type: "quiet"; arg: QuietArg }
  | { type: "usage" };

export const USAGE = [
  "Usage:",
  "`/sym status` or `/sym jobs`: what Sym is working on",
  "`/sym schedules`: the recurring checks and when they run next",
  "`/sym quiet [minutes|2h]`: stay silent except for questions and failures (default 60 minutes)",
  "`/sym quiet off`: end quiet mode",
].join("\n");

export function parseSymCommand(text: string): SymCommand {
  const [first = "", ...rest] = text.trim().split(/\s+/);
  switch (first.toLowerCase()) {
    case "status":
    case "jobs":
      return rest.length === 0 ? { type: "status" } : { type: "usage" };
    case "schedule":
    case "schedules":
      return rest.length === 0 ? { type: "schedules" } : { type: "usage" };
    case "quiet": {
      const arg = parseQuietArg(rest.join(" "));
      return arg ? { type: "quiet", arg } : { type: "usage" };
    }
    default:
      return { type: "usage" };
  }
}

// Slack reads <, >, and & in message text as markup. Worker and job text is data.
export function slackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
