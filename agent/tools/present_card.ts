import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { CardSpec, COMPONENT_GUIDE, renderCard } from "../../lib/cards/card.ts";
import { deliver } from "../../lib/delivery/deliver.ts";
import { chooseDisplay } from "../../lib/display.ts";
import { jobIdOfThread } from "../../lib/feedback/feedback.ts";
import { abandonFailedPost, enqueuePost, postStatus } from "../../lib/ledger/outbox.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { requesterOf } from "../../lib/requester.ts";
import { ledger, ledgerDeps, pack, slackFromEnv } from "../../lib/runtime.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";

// Posts a generative card in this conversation (decision 095). Code validates the spec, renders
// it, and posts it through the display rule and the outbox like any other message.
export default defineTool({
  description:
    "Post a card in this conversation. Text is the default. Use a card only when the person asks " +
    "for a chart, graph, table, or card, or when the data is too much for a few sentences: a " +
    "trend over about six or more points, shares of a whole, or five or more items compared on " +
    "two or more numbers. A few numbers, a status, or a short comparison stays text. When " +
    "unsure, use text. The spec is { root, elements }: root names the Card " +
    "element, each element is { type, props, children }, children name other elements, and an " +
    "element without children has children: []. Use literal values only: no $ expressions, " +
    "repeat, or visible. Rules: the root is a Card; group parts with Section, not another Card. " +
    "Field goes only inside Fields (at most 10), and LinkButton only inside Actions, each with " +
    "its own link. Text is Slack text: *bold*, _italic_, `code`, and [label](https://url) " +
    "links; no headings. A card holds at most one Table (99 rows plus the header, 20 columns) " +
    "and two Charts. A bar, line, or area Chart has at most 20 unique categories and one value " +
    "per category in each series; its title has at most 50 characters and each label at most " +
    "20. Text has at most 3000 characters and the Card title at most 150. " +
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
    const post = await enqueuePost(sql, {
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
    // The card replaces the reply, so a failed send must not end in silence. Sym gives up on the
    // card instead of retrying it, so it can't arrive after the text answer. A card no one has
    // tried yet, or one another sender holds, is still on its way.
    const status = await postStatus(sql, post.id);
    if (status === "failed" || (status === "pending" && (await abandonFailedPost(sql, post.id))))
      return { posted: false, reason: "The card didn't post. Answer in text instead." };
    return { posted: true };
  },
});
