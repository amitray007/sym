// Small in-process memory the Slack channel hooks share with the renderer and the thread
// context rule (decision 050). A miss only makes Sym show more, never less: a missing session
// mark gives the whole thread, and a missing quiet mark shows the status.

const LIMIT = 2000;

function remember(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  if (set.size > LIMIT) set.delete(set.values().next().value as string);
}

// Threads that have a session. Slack's `ts` is unique within a channel, and a thread message
// carries no channel, so the thread root's `ts` alone is the key.
const sessionThreads = new Set<string>();

export function markThreadSession(threadTs: string, hasSession: boolean): void {
  if (hasSession) remember(sessionThreads, threadTs);
  else sessionThreads.delete(threadTs);
}

// Sym's posts that came through the outbox (job cards, results, progress). The session never
// saw them, so they cannot bound the thread context: a follow-up must still see them.
const outboxPosts = new Set<string>();

export function markOutboxPosts(timestamps: readonly string[]): void {
  for (const ts of timestamps) remember(outboxPosts, ts);
}

// The thread context boundary: with a session, a turn reads the thread after Sym's last reply
// that the session wrote. Without a session, the predicate never matches, so the first turn
// reads the whole thread.
export function isLastPostBoundary(message: {
  isMe: boolean;
  threadTs: string;
  ts: string;
}): boolean {
  return message.isMe && sessionThreads.has(message.threadTs) && !outboxPosts.has(message.ts);
}

// Threads whose next turn might not be meant for Sym. Such a turn shows no status until the
// model does real work. Eve's channel state keeps the ts of a session's first message only, so
// the mark is per thread and Slack user, not per message. Eve queues turns of different people,
// so thread and user name one turn. Every message hook sets it for the message it lets through.
const quietTurns = new Set<string>();

export const threadKey = (channelId: string, threadTs: string, userId: string) =>
  `${channelId}:${threadTs}:${userId}`;

export function markQuietTurn(key: string): void {
  remember(quietTurns, key);
}

export function isQuietTurn(key: string | undefined): boolean {
  return key !== undefined && quietTurns.has(key);
}

// The turn was meant for Sym, or did real work. It may show a status.
export function endQuietTurn(key: string | undefined): void {
  if (key !== undefined) quietTurns.delete(key);
}
