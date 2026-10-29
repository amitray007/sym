import { defineTool } from "eve/tools";
import { z } from "zod";
import { deliver } from "../../lib/delivery/deliver.ts";
import { chooseDisplay } from "../../lib/display.ts";
import { ChoiceLabels, choiceBlocks, storeChoices } from "../../lib/ledger/choices.ts";
import { enqueuePost } from "../../lib/ledger/outbox.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

export default defineTool({
  description:
    "Offer two or three next steps in the conversation. Buttons are replies as the clicker, never approval or direct work. Any typed reply still works. Do not repeat the message after this tool posts it.",
  inputSchema: z.object({ message: z.string().trim().min(1).max(6000), choices: ChoiceLabels }),
  async execute(input, ctx) {
    const by = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by))
      return { posted: false, reason: "This needs an allowed person in Slack." };
    const sql = ledger();
    const thread = await getSessionThread(sql, ctx.session.id);
    if (!thread) return { posted: false, reason: "I couldn't find this conversation." };
    const key = `${ctx.session.id}:${ctx.callId}:choices`;
    const stored = await storeChoices(sql, {
      key,
      channel: thread.channelId,
      threadTs: thread.threadTs,
      ...input,
    });
    await enqueuePost(sql, {
      idempotencyKey: key,
      method: "chat.postMessage",
      payload: {
        channel: thread.channelId,
        ...(thread.threadTs ? { thread_ts: thread.threadTs } : {}),
        text: `${input.message}\n\n${input.choices.join(" / ")}. You can also reply in your own words.`,
        blocks: [{ type: "markdown", text: input.message }, ...choiceBlocks(stored)],
      },
      display: chooseDisplay({
        kind: "conversation",
        needsAction: true,
        isNew: true,
        estMinutes: 0,
        steps: 0,
        lines: 1,
        surface: "channel",
        quiet: false,
      }),
    });
    const slack = slackFromEnv();
    if (slack) await deliver(sql, slack);
    return { posted: true };
  },
});
