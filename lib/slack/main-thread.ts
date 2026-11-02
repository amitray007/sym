import type { Sql } from "../db.ts";
import type { LedgerDeps } from "../jobs/run.ts";
import { getSessionThread } from "../ledger/threads.ts";
import { jobOfCodeChannel } from "./code-channel.ts";
import { OVER_CAP, reservePost } from "./own-posts.ts";
import { POST_MAX, postAndConfirm } from "./post.ts";

// The thread a code channel came from, and Sym's posts there on request (decision 079). A code
// channel is the same agent as its thread: it can still speak in the thread when a person asks.

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
  input: { sessionId: string; callId: string; requester?: string | undefined; text: string },
): Promise<string> {
  const text = input.text.trim().slice(0, POST_MAX);
  if (!text) return "The message is empty.";
  const main = await mainThreadOf(deps.sql, input.sessionId);
  if (!main) return "This conversation has no main thread to post in. Reply here instead.";
  const key = `main-thread:${input.sessionId}:${input.callId}`;
  if (input.requester) {
    const reservation = {
      key,
      channelId: main.channel,
      requester: input.requester,
      sessionId: input.sessionId,
    };
    if (!(await reservePost(deps.sql, reservation))) return OVER_CAP;
  }
  const { outcome } = await postAndConfirm(deps, {
    key,
    channel: main.channel,
    threadTs: main.threadTs,
    text,
  });
  if (outcome === "sent") return "Posted in the main thread.";
  if (outcome === "pending")
    return "The post will appear in the main thread once Slack accepts it.";
  return "I couldn't post in the main thread: Slack refused it, or the thread is gone.";
}
