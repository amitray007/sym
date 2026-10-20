import type { Sql } from "../db.ts";
import type { ListenMode } from "../slack/addressing.ts";

// How Sym listens in one Slack thread (migration 016, decision 050). It is kept per thread, not
// per session, so it holds after a session ends. No row means "all".

export async function getListenMode(
  sql: Sql,
  channelId: string,
  threadTs: string,
): Promise<ListenMode> {
  const [row] = await sql<{ mode: ListenMode }[]>`
    select mode from thread_listen where channel_id = ${channelId} and thread_ts = ${threadTs}
  `;
  return row?.mode ?? "all";
}

export async function setListenMode(
  sql: Sql,
  input: { channelId: string; threadTs: string; mode: ListenMode; updatedBy: string | null },
): Promise<void> {
  await sql`
    insert into thread_listen (channel_id, thread_ts, mode, updated_by)
    values (${input.channelId}, ${input.threadTs}, ${input.mode}, ${input.updatedBy})
    on conflict (channel_id, thread_ts) do update set
      mode = excluded.mode,
      updated_by = excluded.updated_by,
      updated_at = now()
  `;
}
