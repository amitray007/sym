import type { Sql } from "./db.ts";
import { deliver } from "./delivery/deliver.ts";
import { chooseDisplay } from "./display.ts";
import { enqueuePost, postStatus } from "./ledger/outbox.ts";
import type { SlackApi } from "./slack/api.ts";

// Sends a sign-in link to the owner's DM through the outbox (decisions 036 and 045). The link
// never goes to a shared thread or a log. A DM that cannot go out now stays queued, and the
// delivery schedule retries it.
export async function sendSignInLink(
  sql: Sql,
  slack: SlackApi | undefined,
  input: { owner: string; idempotencyKey: string; text: string },
): Promise<"sent" | "queued"> {
  const display = chooseDisplay({
    kind: "sign-in",
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: 2,
    surface: "dm",
    quiet: false,
  });
  const post = await enqueuePost(sql, {
    idempotencyKey: input.idempotencyKey,
    method: "chat.postMessage",
    payload: {
      channel: input.owner,
      text: input.text,
      unfurl_links: false,
      unfurl_media: false,
    },
    display: { ...display, target: "dm" },
  });
  // A failed send stays in the outbox for the delivery schedule.
  if (slack) await deliver(sql, slack).catch(() => {});
  return (await postStatus(sql, post.id)) === "sent" ? "sent" : "queued";
}
