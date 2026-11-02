import type { Caller } from "../callers.ts";
import type { Sql } from "../db.ts";
import { isAppSession } from "../requester.ts";
import { readInTurn } from "../slack/read.ts";
import { isTriggerRunSession } from "./rows.ts";

// The decision 082 safeguard for gated writes: a turn that read Slack content asks the requester
// to approve a later write. A trigger run's session starts with event text from whoever wrote the
// message (decision 088), and that text stays in the session's context, so every turn of the
// session counts as read: the run's own turns and a person's later turns in its thread alike. A
// post, DM, edit, bookmark, or canvas write in another conversation then waits for approval. The
// run's own reply in its destination is not a tool call, so it needs none. A failed lookup counts
// as read.
export async function readUntrustedInTurn(
  session: { id: string; turn?: { id: string }; auth?: { current?: Caller } } | undefined,
  sql: () => Sql,
): Promise<boolean> {
  if (!session) return false;
  if (readInTurn(session)) return true;
  // A person's turn comes long after the run's attach, so only a run's own turn waits for it.
  const wait = isAppSession({ id: session.id, auth: { current: session.auth?.current } });
  return isTriggerRunSession(sql(), session.id, { wait }).catch(() => true);
}
