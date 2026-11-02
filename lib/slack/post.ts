import { chooseDisplay } from "../display.ts";
import { deliverNow, type LedgerDeps } from "../jobs/run.ts";
import { enqueuePost } from "../ledger/outbox.ts";

// One post the brain asked for, through the outbox, reported only from what Slack confirmed.
// The idempotency key makes a retried tool call post once.

// The longest message Sym posts on request.
export const POST_MAX = 3000;

export type PostOutcome = "sent" | "pending" | "failed";

export interface ConfirmedPost {
  key: string;
  channel: string;
  threadTs?: string | undefined;
  // Edits the message with this ts instead of posting a new one.
  editTs?: string | undefined;
  text: string;
}

export async function postAndConfirm(
  deps: LedgerDeps,
  post: ConfirmedPost,
): Promise<{ outcome: PostOutcome }> {
  await enqueuePost(deps.sql, {
    idempotencyKey: post.key,
    method: post.editTs ? "chat.update" : "chat.postMessage",
    payload: {
      channel: post.channel,
      ...(post.editTs ? { ts: post.editTs } : {}),
      ...(post.threadTs ? { thread_ts: post.threadTs } : {}),
      text: post.text,
    },
    display: chooseDisplay({
      kind: "conversation",
      needsAction: false,
      isNew: true,
      estMinutes: 0,
      steps: 0,
      lines: post.text.split("\n").length,
      surface: /^D/.test(post.channel) ? "dm" : "channel",
      quiet: false,
    }),
  });
  await deliverNow(deps);
  const [row] = await deps.sql<{ status: string }[]>`
    select status from outbox where idempotency_key = ${post.key}
  `;
  if (row?.status === "sent") return { outcome: "sent" };
  return { outcome: row?.status === "pending" ? "pending" : "failed" };
}
