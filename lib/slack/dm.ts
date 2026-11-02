import type { LedgerDeps } from "../jobs/run.ts";
import { getSessionThread } from "../ledger/threads.ts";
import { OVER_CAP, reservePost } from "./own-posts.ts";
import { lookUpPerson, type PersonDeps, slackUserId, UNKNOWN_PERSON } from "./people.ts";
import { POST_MAX, postAndConfirm } from "./post.ts";
import { isPrivateConversation } from "./reach.ts";

// A DM to a person when someone asks (decision 083). Only a current, human member of this
// workspace gets one. It shares the hourly post cap, and the ledger records who asked, so only
// they can have Sym edit or delete it.

export interface DmInput {
  sessionId: string;
  callId: string;
  requester: string | undefined;
  person: string;
  text: string;
}

type DmDeps = LedgerDeps & PersonDeps;

export async function sendDirectMessage(deps: DmDeps, input: DmInput): Promise<string> {
  const text = input.text.trim().slice(0, POST_MAX);
  if (!text) return "The message is empty.";
  if (!input.requester || !deps.slack) return UNKNOWN_PERSON;
  const person = await lookUpPerson(deps, input.requester, input.person);
  if (!person) return UNKNOWN_PERSON;
  if (person.isBot || person.deactivated || person.external) {
    return "I only send DMs to current people in this workspace.";
  }
  const opened = await deps.slack
    .call("conversations.open", { users: person.id })
    .catch(() => undefined);
  const channel = (opened?.channel as { id?: string } | undefined)?.id;
  if (!channel) return "I couldn't open a DM with them.";
  const key = `slack-dm:${input.sessionId}:${input.callId}`;
  const reserved = await reservePost(deps.sql, {
    key,
    channelId: channel,
    requester: input.requester,
    sessionId: input.sessionId,
  });
  if (!reserved) return OVER_CAP;
  const { outcome } = await postAndConfirm(deps, { key, channel, text });
  if (outcome === "sent") return `Sent to ${person.name}.`;
  if (outcome === "pending") return "The DM will arrive once Slack accepts it.";
  return "I couldn't send the DM: Slack refused it.";
}

// A DM carries words out of the conversation it was asked in. From a DM or private channel, the
// requester approves it first, unless the DM goes to the requester.
export async function dmNeedsConfirmation(
  deps: Pick<LedgerDeps, "sql" | "slack">,
  sessionId: string,
  requester: string | undefined,
  person: string | undefined,
): Promise<boolean> {
  if (requester && slackUserId(person ?? "") === requester) return false;
  const source = await getSessionThread(deps.sql, sessionId);
  if (!source || !deps.slack) return true;
  return isPrivateConversation(deps.slack, source.channelId);
}
