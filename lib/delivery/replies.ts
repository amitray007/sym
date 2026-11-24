import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { enqueuePost, postStatus } from "../ledger/outbox.ts";
import type { SlackApi } from "../slack/api.ts";
import { replyTightener, type Tighten } from "../voice/tighten.ts";
import { deliver, ROOT_GUARD_FIELD } from "./deliver.ts";

// Brain replies use the same durable delivery path as job posts. Long replies retain the full
// Markdown as a document. A missing root must not turn a private thread reply into a channel post.
// A reply that reads as a wall of text gets one rewrite pass first (decision 103).
export async function queueReply(
  sql: Sql,
  slack: SlackApi,
  input: {
    key: string;
    channel: string;
    threadTs: string | null;
    text: string;
  },
  tighten: Tighten | undefined = replyTightener(),
): Promise<boolean> {
  const text = tighten ? await tighten(input.text) : input.text;
  const display = chooseDisplay({
    kind: "reply",
    needsAction: false,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: text.split("\n").length,
    characters: text.length,
    surface: input.channel.startsWith("D") ? "dm" : "channel",
    quiet: false,
  });
  const post = await enqueuePost(sql, {
    idempotencyKey: input.key,
    method: text.length > 12000 ? "sym.document" : "chat.postMessage",
    payload: {
      channel: input.channel,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      text: text,
      [ROOT_GUARD_FIELD]: true,
      ...(text.length <= 12000 ? { blocks: [{ type: "markdown", text: text }] } : {}),
    },
    display,
  });
  await deliver(sql, slack);
  return (await postStatus(sql, post.id)) === "sent";
}
