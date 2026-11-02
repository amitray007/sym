import type { Sql } from "../db.ts";
import type { LedgerDeps } from "../jobs/run.ts";
import { type SlackApi, SlackApiError } from "./api.ts";
import { isSlackUserAllowed } from "./guard.ts";
import { POST_MAX, postAndConfirm } from "./post.ts";
import { parseSlackTarget, type ReachDeps, reachConversation, UNREACHABLE } from "./reach.ts";

// The posts Sym made because a person asked (decision 082). Each row names who asked. Only that
// person can edit or delete the post, and each person gets a capped number of posts an hour.

export const POSTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

export const NOT_YOURS = "I can only change a post I made because you asked for it.";

export interface RequestedPost {
  postKey: string;
  channelId: string;
  messageTs: string;
  requester: string;
  sessionId: string;
}

export interface PostReservation {
  key: string;
  channelId: string;
  requester: string;
  sessionId: string;
}

// Claims one of the requester's hourly posts before the post is sent, so a post still pending in
// the outbox counts and stays theirs. A lock per requester keeps parallel calls under the cap.
// A retried call with the same key keeps its claim. False when the requester is over the cap.
export async function reservePost(
  sql: Sql,
  post: PostReservation,
  now = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - HOUR_MS);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`requested-posts:${post.requester}`}, 0))`;
    const [held] = await tx`select 1 from requested_posts where post_key = ${post.key}`;
    if (held) return true;
    const [row] = await tx<{ count: number }[]>`
      select count(*)::int as count from requested_posts
      where requester = ${post.requester} and created_at > ${since}
    `;
    if ((row?.count ?? 0) >= POSTS_PER_HOUR) return false;
    await tx`
      insert into requested_posts (post_key, channel_id, requester, session_id)
      values (${post.key}, ${post.channelId}, ${post.requester}, ${post.sessionId})
    `;
    return true;
  });
}

export async function isReserved(sql: Sql, key: string): Promise<boolean> {
  const [row] = await sql`select 1 from requested_posts where post_key = ${key}`;
  return row !== undefined;
}

export const OVER_CAP = `You've asked for ${POSTS_PER_HOUR} posts in the last hour. Try again later.`;

// The requester's post named by a link, or their latest post from this conversation. Only a post
// Slack accepted has a ts to change.
export async function findOwnPost(
  sql: Sql,
  requester: string | undefined,
  sessionId: string,
  message: string | undefined,
): Promise<RequestedPost | undefined> {
  if (!requester) return undefined;
  const target = message ? parseSlackTarget(message) : undefined;
  if (message && !target?.messageTs) return undefined;
  const [row] = await sql<RequestedPost[]>`
    select p.post_key, p.channel_id, o.slack_ts as message_ts, p.requester, p.session_id
    from requested_posts p join outbox o on o.idempotency_key = p.post_key
    where p.requester = ${requester} and p.deleted_at is null
      and o.status = 'sent' and o.slack_ts is not null
      and ${
        target
          ? sql`p.channel_id = ${target.channel} and o.slack_ts = ${target.messageTs ?? ""}`
          : sql`p.session_id = ${sessionId}`
      }
    order by p.created_at desc limit 1
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
  if (!(await mayChange(deps, input.requester, post))) return UNREACHABLE;
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
  if (!(await mayChange(deps, input.requester, post))) return UNREACHABLE;
  const deleted = await deleteMessage(deps.slack as SlackApi, post);
  if (!deleted) return "I couldn't delete it: Slack refused.";
  await deps.sql`
    update requested_posts set deleted_at = now() where post_key = ${post.postKey}
  `;
  return "Deleted.";
}

// A DM Sym sent for someone is a conversation they are not in, so for a DM the allow-list and
// the ledger's record of who asked decide. Elsewhere the decision 081 checks apply.
async function mayChange(
  deps: OwnPostDeps,
  requester: string | undefined,
  post: RequestedPost,
): Promise<boolean> {
  if (!post.channelId.startsWith("D")) {
    return (await reachConversation(deps, requester, post.channelId)) !== undefined;
  }
  return isSlackUserAllowed(deps.pack, deps.usersEnv ?? process.env.SYM_SLACK_USERS, requester);
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
