import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { deliverNow, type LedgerDeps } from "../jobs/run.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import { getSessionThread } from "../ledger/threads.ts";
import { jobOfCodeChannel } from "./code-channel.ts";

// The thread a code channel came from, and Sym's posts there on request (decision 079). A code
// channel is the same agent as its thread: it can still speak in the thread when a person asks.

// The longest message Sym posts in the main thread.
export const MAIN_THREAD_POST_MAX = 3000;

export interface MainThread {
  channel: string;
  threadTs: string;
}

// Records where a conversation channel came from. A job channel keeps its origin on the job row.
export async function recordChannelOrigin(
  sql: Sql,
  sessionId: string,
  origin: MainThread,
): Promise<void> {
  await sql`
    insert into code_channel_origins (session_id, origin_channel, origin_thread_ts)
    values (${sessionId}, ${origin.channel}, ${origin.threadTs})
    on conflict (session_id) do nothing
  `;
}

// The main thread of the code channel this session talks in: the job's origin, else the origin
// recorded when the conversation moved. Undefined outside a code channel or for an unknown one.
export async function mainThreadOf(sql: Sql, sessionId: string): Promise<MainThread | undefined> {
  const thread = await getSessionThread(sql, sessionId);
  if (thread) {
    const job = await jobOfCodeChannel(sql, thread.channelId);
    if (job?.originChannel && job.originThreadTs) {
      return { channel: job.originChannel, threadTs: job.originThreadTs };
    }
  }
  const [row] = await sql<{ originChannel: string; originThreadTs: string }[]>`
    select origin_channel, origin_thread_ts from code_channel_origins where session_id = ${sessionId}
  `;
  return row ? { channel: row.originChannel, threadTs: row.originThreadTs } : undefined;
}

// Posts the brain's message in the main thread. One post per tool call. Says "posted" only after
// Slack confirms it.
export async function postToMainThread(
  deps: LedgerDeps,
  input: { sessionId: string; callId: string; text: string },
): Promise<string> {
  const text = input.text.trim().slice(0, MAIN_THREAD_POST_MAX);
  if (!text) return "The message is empty.";
  const main = await mainThreadOf(deps.sql, input.sessionId);
  if (!main) return "This conversation has no main thread to post in. Reply here instead.";
  const key = `main-thread:${input.sessionId}:${input.callId}`;
  await enqueuePost(deps.sql, {
    idempotencyKey: key,
    method: "chat.postMessage",
    payload: { channel: main.channel, thread_ts: main.threadTs, text },
    display: chooseDisplay({
      kind: "conversation",
      needsAction: false,
      isNew: true,
      estMinutes: 0,
      steps: 0,
      lines: text.split("\n").length,
      surface: /^D/.test(main.channel) ? "dm" : "channel",
      quiet: false,
    }),
  });
  await deliverNow(deps);
  const [post] = await deps.sql<{ status: string }[]>`
    select status from outbox where idempotency_key = ${key}
  `;
  if (post?.status === "sent") return "Posted in the main thread.";
  if (post?.status === "pending")
    return "The post will appear in the main thread once Slack accepts it.";
  return "I couldn't post in the main thread: Slack refused it, or the thread is gone.";
}
