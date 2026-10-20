import type { Sql } from "../db.ts";
import { setListenMode } from "../ledger/listen.ts";
import type { SessionThread } from "../ledger/threads.ts";
import type { ListenMode } from "./addressing.ts";

// What `thread_listen` does, apart from Eve (decision 050). Any allowed person may change it,
// with no approval: the setting only makes Sym quieter, or back to normal.

export const LISTEN_DM =
  "Listening only applies to a thread with several people, not a direct message.";
export const LISTEN_NO_THREAD = "Sym cannot tell which thread this is. Ask again in the thread.";

export async function changeListenMode(input: {
  sql: Sql;
  thread: SessionThread | undefined;
  mode: ListenMode;
  userId: string | undefined;
}): Promise<string> {
  const { thread } = input;
  if (!thread?.threadTs) return LISTEN_NO_THREAD;
  if (thread.channelId.startsWith("D")) return LISTEN_DM;
  await setListenMode(input.sql, {
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    mode: input.mode,
    updatedBy: input.userId ?? null,
  });
  return input.mode === "mention-only"
    ? "Done. In this thread Sym answers only when tagged."
    : "Done. In this thread Sym answers messages meant for it, as before.";
}
