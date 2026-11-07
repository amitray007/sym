import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { CardSpec, COMPONENT_GUIDE, renderCard } from "../../lib/cards/card.ts";
import { deliver } from "../../lib/delivery/deliver.ts";
import { chooseDisplay } from "../../lib/display.ts";
import { jobIdOfThread } from "../../lib/feedback/feedback.ts";
import { enqueuePost } from "../../lib/ledger/outbox.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { requesterOf } from "../../lib/requester.ts";
import { ledger, ledgerDeps, pack, slackFromEnv } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

// Posts a generative card in this conversation (decision 095). Code validates the spec, renders
// it, and posts it through the display rule and the outbox like any other message.
export default defineTool({
  description:
    "Post a card in this conversation when a chart, a grid of numbers, or a data table shows the " +
    "answer better than text, or when the person asks for a chart, graph, or card. Plain answers " +
    "and short Markdown tables stay text. The spec is { root, elements }: root names the Card " +
    "element, each element is { type, props, children }, children name other elements, and an " +
    "element without children has children: []. Use literal values only: no $ expressions, " +
    "repeat, or visible. A card holds at most one Table (100 rows) and two Charts. " +
    `Components:\n${COMPONENT_GUIDE}\n` +
    "Use only facts from the conversation or tools; never invent numbers. Keep text short. If the " +
    "tool returns issues, fix the spec and call it again. If it returns a reason, answer in text. " +
    "After posted: true, call no_reply.",
  inputSchema: z.object({ spec: CardSpec }),
  label: { start: () => "Post a card" },
  async execute({ spec }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const by = await requesterOf(ctx.session, ledgerDeps);
    if (!isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, by))
      return { posted: false, reason: "This needs an allowed person in Slack." };
    const sql = ledger();
    const thread = await getSessionThread(sql, ctx.session.id);
    if (!thread) return { posted: false, reason: "I couldn't find this conversation." };
    const card = renderCard(spec);
    if (!card.ok) return { posted: false, issues: card.issues };
    const display = chooseDisplay({
      kind: "card",
      needsAction: false,
      isNew: true,
      estMinutes: 0,
      steps: 0,
      lines: card.text.split("\n").length,
      characters: card.text.length,
      surface: thread.channelId.startsWith("D") ? "dm" : "channel",
      quiet: false,
    });
    if (display.level !== 1)
      return { posted: false, reason: "This is too long for a card. Reply in text instead." };
    const jobId = await jobIdOfThread(sql, thread.channelId, thread.threadTs ?? "");
    await enqueuePost(sql, {
      idempotencyKey: `${ctx.session.id}:${ctx.callId}:card`,
      ...(jobId ? { jobId } : {}),
      method: "chat.postMessage",
      payload: {
        channel: thread.channelId,
        ...(thread.threadTs ? { thread_ts: thread.threadTs } : {}),
        text: card.text,
        blocks: card.blocks,
      },
      display,
    });
    const slack = slackFromEnv();
    if (slack) await deliver(sql, slack);
    return { posted: true };
  },
});
