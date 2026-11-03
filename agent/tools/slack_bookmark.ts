import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { requesterOf, requesterResponse } from "../../lib/requester.ts";
import { ledgerDeps, pack, slackFromEnv } from "../../lib/runtime.ts";
import { addBookmark } from "../../lib/slack/pins.ts";
import { postNeedsConfirmation } from "../../lib/slack/slack-post.ts";
import { readUntrustedInTurn } from "../../lib/triggers/untrusted.ts";

// Adds a link bookmark to a channel when a person asks (decision 084). It follows the post
// approval rules, since its title and link carry words into the channel.
export default defineTool({
  description:
    "Add a link bookmark to a Slack channel when a person asks, such as 'bookmark the runbook " +
    "in #ops'. Pass the channel, a short title, and the https link. Never bookmark on your own.",
  inputSchema: z.object({
    target: z.string().min(1).max(500).describe("A #channel, channel mention, or channel link."),
    title: z.string().min(1).max(100).describe("A short title for the bookmark."),
    url: z.string().min(1).max(2000).describe("The https link to bookmark."),
  }),
  approval: {
    request: ({ session, toolInput }) =>
      postNeedsConfirmation(
        ledgerDeps(),
        session.id,
        toolInput?.target,
        `${toolInput?.title ?? ""} ${toolInput?.url ?? ""}`,
      ).then(async (ask) =>
        ask || (await readUntrustedInTurn(session, () => ledgerDeps().sql))
          ? "user-approval"
          : "not-applicable",
      ),
    response: requesterResponse("Only the person who asked can approve this bookmark.", ledgerDeps),
    prompt: ({ input }) => `Bookmark "${input.title}" (${input.url}) in ${input.target}?`,
  },
  label: { start: () => "Add a bookmark" },
  async execute({ target, title, url }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return addBookmark(
      { slack: slackFromEnv(), pack: pack() },
      await requesterOf(ctx.session, ledgerDeps),
      { target, title, url },
    );
  },
});
