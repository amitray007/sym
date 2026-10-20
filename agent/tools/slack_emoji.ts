import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { emojiCache } from "../../lib/runtime.ts";

// Finds the workspace's custom emoji by keyword (decision 051). Read-only. Standard emoji need
// no search: slack_react takes their usual names.
export default defineTool({
  description:
    "Search the workspace's custom emoji by keyword, such as party, ship, or facepalm. " +
    "Returns up to 20 names. Standard emoji are not listed; use their usual names directly.",
  inputSchema: z.object({
    keyword: z.string().min(1).max(50).describe("Part of an emoji name."),
  }),
  label: { start: ({ keyword }) => `Find emoji ${keyword}` },
  async execute({ keyword }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const found = await emojiCache().search(keyword);
    if (found.error === "missing_scope") {
      return "Sym cannot list custom emoji until the app has the emoji:read scope. Standard emoji still work.";
    }
    if (found.error) return `Sym could not list custom emoji (${found.error}).`;
    if (found.names.length === 0) return `No custom emoji matches "${keyword}".`;
    return { emoji: found.names };
  },
});
