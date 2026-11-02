import type { Sql } from "../db.ts";
import { getSessionThread } from "../ledger/threads.ts";
import { type SlackApi, SlackApiError } from "../slack/api.ts";
import {
  parseSlackTarget,
  type ReachDeps,
  reachConversation,
  UNREACHABLE,
} from "../slack/reach.ts";
import { normalizeEmoji } from "./emoji.ts";

// A reaction on the message that started the turn (decision 051). Code holds the limits, not the
// prompt: one reaction per message, three per thread per hour. Reactions go only on a person's
// message, so Sym's own sign-in links, approval prompts, and job cards never get one.

export const THREAD_CAP = 3;
export const THREAD_WINDOW_MS = 60 * 60 * 1000;

// Remembers the message that started the session's latest turn. The session's thread row must
// exist, so call it after recordSessionThread.
// Records the newest message of a thread Sym already follows. A thread with no session row yet
// changes nothing: turn.started records the first message with the row.
export async function recordThreadMessage(
  sql: Sql,
  channelId: string,
  threadTs: string,
  messageTs: string,
): Promise<void> {
  await sql`update session_threads set message_ts = ${messageTs}
    where channel_id = ${channelId} and thread_ts = ${threadTs}`;
}

export async function recordTurnMessage(
  sql: Sql,
  sessionId: string,
  messageTs: string,
): Promise<void> {
  // Only the first message: later ones come from recordThreadMessage, and Eve's trigger stays
  // on the first message of the session.
  await sql`
    update session_threads set message_ts = ${messageTs}
    where session_id = ${sessionId} and message_ts is null
  `;
}

async function turnMessageTs(sql: Sql, sessionId: string): Promise<string | null> {
  const [row] = await sql<{ messageTs: string | null }[]>`
    select message_ts from session_threads where session_id = ${sessionId}
  `;
  return row?.messageTs ?? null;
}

// Snapshot before model work starts. Later inbound messages may update the thread row.
const turnTargets = new Map<string, string | null>();
export async function captureReactionTarget(
  sql: Sql,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const key = `${sessionId}:${turnId}`;
  if (turnTargets.has(key)) return;
  turnTargets.set(key, await turnMessageTs(sql, sessionId));
  if (turnTargets.size > 2000) turnTargets.delete(turnTargets.keys().next().value as string);
}
export function reactionTarget(sessionId: string, turnId: string): string | null {
  return turnTargets.get(`${sessionId}:${turnId}`) ?? null;
}

export interface ReactDeps {
  sql: Sql;
  // Undefined when the deployment has no bot token.
  api: SlackApi | undefined;
  now?: Date;
  messageTs?: string | null;
}

// Returns a short sentence for the model. It never throws on a Slack refusal.
export async function reactToTurn(
  deps: ReactDeps,
  sessionId: string,
  emoji: string,
): Promise<string> {
  const normalized = normalizeEmoji(emoji);
  if (!normalized.ok) return normalized.message;
  if (!deps.api) return "Sym has no Slack access, so it cannot react.";

  const thread = await getSessionThread(deps.sql, sessionId);
  const messageTs = thread
    ? deps.messageTs === undefined
      ? await turnMessageTs(deps.sql, sessionId)
      : deps.messageTs
    : null;
  if (!thread || !messageTs) return "This conversation has no Slack message to react to.";
  const threadTs = thread.threadTs ?? messageTs;
  const since = new Date((deps.now ?? new Date()).getTime() - THREAD_WINDOW_MS);

  const claim = await deps.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${thread.channelId}:${threadTs}`}, 0))`;
    const [recent] = await tx<{ count: number }[]>`
      select count(*)::int as count from reactions
      where channel_id = ${thread.channelId} and thread_ts = ${threadTs} and created_at > ${since}
    `;
    if ((recent?.count ?? 0) >= THREAD_CAP) return "cap";
    const claimed = await tx`
      insert into reactions (channel_id, message_ts, thread_ts, name)
      values (${thread.channelId}, ${messageTs}, ${threadTs}, ${normalized.name})
      on conflict do nothing returning message_ts
    `;
    return claimed.length ? "ok" : "duplicate";
  });
  if (claim === "cap")
    return "Sym has used its reactions for this thread this hour. Reply in text or stay silent.";
  if (claim === "duplicate") return "Sym already reacted to this message. Do not react again.";

  try {
    await deps.api.call("reactions.add", {
      channel: thread.channelId,
      timestamp: messageTs,
      name: normalized.name,
    });
    return `Reacted with :${normalized.name}:.`;
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "request_failed";
    // The message already carries this reaction. Nothing is wrong.
    if (code === "already_reacted") return `Already reacted with :${normalized.name}:.`;
    await deps.sql`
      delete from reactions where channel_id = ${thread.channelId} and message_ts = ${messageTs}
    `;
    console.warn(`Sym could not add a reaction: ${code}`);
    if (code === "invalid_name") {
      return `Slack does not know :${normalized.name}:. Look up a custom emoji, or pick a standard name.`;
    }
    return `Slack refused the reaction (${code}). Do not retry.`;
  }
}

// Takes Sym's reaction off the message that started the turn, when a person asks.
export async function unreactToTurn(
  deps: ReactDeps,
  sessionId: string,
  emoji: string,
): Promise<string> {
  const normalized = normalizeEmoji(emoji);
  if (!normalized.ok) return normalized.message;
  if (!deps.api) return "Sym has no Slack access, so it cannot react.";
  const thread = await getSessionThread(deps.sql, sessionId);
  const messageTs = thread
    ? deps.messageTs === undefined
      ? await turnMessageTs(deps.sql, sessionId)
      : deps.messageTs
    : null;
  if (!thread || !messageTs) return "This conversation has no Slack message to react to.";
  const removed = await setReaction(deps.api, thread.channelId, messageTs, normalized.name, false);
  if (removed === "done") {
    await deps.sql`
      delete from reactions where channel_id = ${thread.channelId} and message_ts = ${messageTs}
    `;
  }
  return reactionReply(removed, normalized.name, false);
}

// Adds or removes Sym's reaction on a linked message, when a person asks (decision 082). The
// requester must be allowed and a member of that conversation, as for posts.
export async function reactToLinkedMessage(
  deps: ReactDeps & ReachDeps,
  requester: string | undefined,
  link: string,
  emoji: string,
  add: boolean,
): Promise<string> {
  const normalized = normalizeEmoji(emoji);
  if (!normalized.ok) return normalized.message;
  const target = parseSlackTarget(link);
  if (!target?.messageTs) return "Give me a link to the message.";
  if (!(await reachConversation({ ...deps, slack: deps.api }, requester, target.channel))) {
    return UNREACHABLE;
  }
  const result = await setReaction(
    deps.api as SlackApi,
    target.channel,
    target.messageTs,
    normalized.name,
    add,
  );
  return reactionReply(result, normalized.name, add);
}

type ReactionResult = "done" | "already" | "unknown_emoji" | "refused";

async function setReaction(
  api: SlackApi,
  channel: string,
  timestamp: string,
  name: string,
  add: boolean,
): Promise<ReactionResult> {
  try {
    await api.call(add ? "reactions.add" : "reactions.remove", { channel, timestamp, name });
    return "done";
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "request_failed";
    if (code === "already_reacted" || code === "no_reaction") return "already";
    if (code === "invalid_name") return "unknown_emoji";
    console.warn(`Sym could not ${add ? "add" : "remove"} a reaction: ${code}`);
    return "refused";
  }
}

function reactionReply(result: ReactionResult, name: string, add: boolean): string {
  if (result === "done") return add ? `Reacted with :${name}:.` : `Removed :${name}:.`;
  if (result === "already")
    return add ? `Already reacted with :${name}:.` : `No :${name}: of mine there.`;
  if (result === "unknown_emoji") return `Slack does not know :${name}:.`;
  return "Slack refused. Do not retry.";
}
