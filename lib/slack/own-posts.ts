import type { Sql } from "../db.ts";
import type { LedgerDeps } from "../jobs/run.ts";
import { type SlackApi, SlackApiError } from "./api.ts";
import { POST_MAX, postAndConfirm } from "./post.ts";
import { parseSlackTarget, type ReachDeps, reachConversation, UNREACHABLE } from "./reach.ts";

// The posts Sym made because a person asked (decision 082). Each row names who asked. Only that
// person can edit or delete the post, and each person gets a capped number of posts an hour.

export const POSTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

export const NOT_YOURS = "I can only change a post I made because you asked for it.";

export interface RequestedPost {
  channelId: string;
  messageTs: string;
  requester: string;
  sessionId: string;
}

export async function recordRequestedPost(sql: Sql, post: RequestedPost): Promise<void> {
  await sql`
    insert into requested_posts (channel_id, message_ts, requester, session_id)
    values (${post.channelId}, ${post.messageTs}, ${post.requester}, ${post.sessionId})
    on conflict do nothing
  `;
}

export async function overHourlyCap(
  sql: Sql,
  requester: string,
  now = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - HOUR_MS);
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from requested_posts
    where requester = ${requester} and created_at > ${since}
  `;
  return (row?.count ?? 0) >= POSTS_PER_HOUR;
}

export const OVER_CAP = `You've asked for ${POSTS_PER_HOUR} posts in the last hour. Try again later.`;

// The requester's post named by a link, or their latest post from this conversation.
export async function findOwnPost(
  sql: Sql,
  requester: string | undefined,
  sessionId: string,
  message: string | undefined,
): Promise<RequestedPost | undefined> {
  if (!requester) return undefined;
  if (message) {
    const target = parseSlackTarget(message);
    if (!target?.messageTs) return undefined;
    const [row] = await sql<RequestedPost[]>`
      select channel_id, message_ts, requester, session_id from requested_posts
      where channel_id = ${target.channel} and message_ts = ${target.messageTs}
        and requester = ${requester} and deleted_at is null
    `;
    return row;
  }
  const [row] = await sql<RequestedPost[]>`
    select channel_id, message_ts, requester, session_id from requested_posts
    where requester = ${requester} and session_id = ${sessionId} and deleted_at is null
    order by created_at desc limit 1
  `;
  return row;
}

type OwnPostDeps = LedgerDeps & ReachDeps;

export interface OwnPostInput {
  sessionId: string;
  callId: string;
  requester: string | undefined;
  message?: string | undefined;
}

export async function editOwnPost(
  deps: OwnPostDeps,
  input: OwnPostInput & { text: string },
): Promise<string> {
  const text = input.text.trim().slice(0, POST_MAX);
  if (!text) return "The message is empty.";
  const post = await findOwnPost(deps.sql, input.requester, input.sessionId, input.message);
  if (!post) return NOT_YOURS;
  if (!(await reachConversation(deps, input.requester, post.channelId))) return UNREACHABLE;
  const { outcome } = await postAndConfirm(deps, {
    key: `slack-edit:${input.sessionId}:${input.callId}`,
    channel: post.channelId,
    editTs: post.messageTs,
    text,
  });
  if (outcome === "sent") return "Edited.";
  if (outcome === "pending") return "The edit will appear once Slack accepts it.";
  return "I couldn't edit it: Slack refused, or the post is gone.";
}

export async function deleteOwnPost(deps: OwnPostDeps, input: OwnPostInput): Promise<string> {
  const post = await findOwnPost(deps.sql, input.requester, input.sessionId, input.message);
  if (!post) return NOT_YOURS;
  if (!(await reachConversation(deps, input.requester, post.channelId))) return UNREACHABLE;
  const deleted = await deleteMessage(deps.slack as SlackApi, post);
  if (!deleted) return "I couldn't delete it: Slack refused.";
  await deps.sql`
    update requested_posts set deleted_at = now()
    where channel_id = ${post.channelId} and message_ts = ${post.messageTs}
  `;
  return "Deleted.";
}

// A post someone already removed counts as deleted.
async function deleteMessage(slack: SlackApi, post: RequestedPost): Promise<boolean> {
  try {
    await slack.call("chat.delete", { channel: post.channelId, ts: post.messageTs });
    return true;
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "unknown_error";
    if (code === "message_not_found") return true;
    console.warn(`Sym could not delete a post: ${code}.`);
    return false;
  }
}
