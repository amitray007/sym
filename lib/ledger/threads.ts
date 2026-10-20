import type { Sql } from "../db.ts";

// The Slack thread of each Eve session (migration 002). Sym's own posts for a job go to the
// thread the job was asked in, even after the session that started it is gone.

export interface SessionThread {
  sessionId: string;
  teamId: string | null;
  channelId: string;
  threadTs: string | null;
  userId: string | null;
}

export async function recordSessionThread(sql: Sql, thread: SessionThread): Promise<void> {
  await sql`
    insert into session_threads (session_id, team_id, channel_id, thread_ts, user_id)
    values (
      ${thread.sessionId}, ${thread.teamId}, ${thread.channelId}, ${thread.threadTs},
      ${thread.userId}
    )
    on conflict (session_id) do update set
      team_id = excluded.team_id,
      channel_id = excluded.channel_id,
      thread_ts = coalesce(excluded.thread_ts, session_threads.thread_ts),
      user_id = coalesce(excluded.user_id, session_threads.user_id),
      updated_at = now()
  `;
}

export async function getSessionThread(
  sql: Sql,
  sessionId: string,
): Promise<SessionThread | undefined> {
  const [row] = await sql<SessionThread[]>`
    select session_id, team_id, channel_id, thread_ts, user_id
    from session_threads where session_id = ${sessionId}
  `;
  return row;
}

// The person Sym last served in a Slack thread: the user of the thread's most recent turn. Only
// the owner of a turn can start one by tag, so this is who Sym works for (decision 050).
export async function lastTurnUser(
  sql: Sql,
  channelId: string,
  threadTs: string,
): Promise<string | undefined> {
  const [row] = await sql<{ userId: string }[]>`
    select user_id from session_threads
    where channel_id = ${channelId} and thread_ts = ${threadTs} and user_id is not null
    order by updated_at desc limit 1
  `;
  return row?.userId;
}
