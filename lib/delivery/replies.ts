import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { enqueuePost, postStatus } from "../ledger/outbox.ts";
import type { SlackApi } from "../slack/api.ts";
import { replyTightener, type Tighten } from "../voice/tighten.ts";
import { deliver, ROOT_GUARD_FIELD } from "./deliver.ts";

// Brain replies use the same durable delivery path as job posts. Long replies retain the full
// Markdown as a document. A missing root must not turn a private thread reply into a channel post.
// A reply that reads as a wall of text gets one rewrite pass first (decision 103).
// `replaceTs` names a message of Sym's in the same conversation, such as the waiting line of a DM
// approval, that the reply replaces in place (decision 104). A document still posts anew.
export async function queueReply(
  sql: Sql,
  slack: SlackApi,
  input: {
    key: string;
    channel: string;
    threadTs: string | null;
    text: string;
    replaceTs?: string | null;
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
    ...(input.replaceTs && text.length <= 12000
      ? {
          method: "chat.update" as const,
          payload: {
            channel: input.channel,
            ts: input.replaceTs,
            text,
            blocks: [{ type: "markdown", text }],
          },
        }
      : replyPost(input.channel, input.threadTs, text)),
    display,
  });
  await deliver(sql, slack);
  return (await postStatus(sql, post.id)) === "sent";
}

function replyPost(channel: string, threadTs: string | null, text: string) {
  return {
    method: text.length > 12000 ? ("sym.document" as const) : ("chat.postMessage" as const),
    payload: {
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text,
      [ROOT_GUARD_FIELD]: true,
      ...(text.length <= 12000 ? { blocks: [{ type: "markdown", text }] } : {}),
    },
  };
}
