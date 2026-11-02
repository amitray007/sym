import type { Caller } from "../callers.ts";
import type { Sql } from "../db.ts";
import { isAppSession } from "../requester.ts";
import { readInTurn } from "../slack/read.ts";
import { isTriggerRunSession } from "./rows.ts";

// The decision 082 safeguard for gated writes: a turn that read Slack content asks the requester
// to approve a later write. A trigger run's turn starts with event text from whoever wrote the
// message (decision 088), so it counts as read from its first step: a post, DM, edit, bookmark,
// or canvas write in another conversation waits for the creator's approval. The run's own reply
// in its destination is not a tool call, so it needs none. A failed lookup counts as read.
export async function readUntrustedInTurn(
  session: { id: string; turn?: { id: string }; auth?: { current?: Caller } } | undefined,
  sql: () => Sql,
): Promise<boolean> {
  if (!session) return false;
  if (readInTurn(session)) return true;
  if (!isAppSession({ id: session.id, auth: { current: session.auth?.current } })) return false;
  return isTriggerRunSession(sql(), session.id).catch(() => true);
}
