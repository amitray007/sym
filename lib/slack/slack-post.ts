import type { LedgerDeps } from "../jobs/run.ts";
import { getSessionThread } from "../ledger/threads.ts";
import { POST_MAX, postAndConfirm } from "./post.ts";
import { isPrivateConversation, reachConversation, resolveTarget, UNREACHABLE } from "./reach.ts";

// Posts in another channel or thread on request (decision 081). The post names who asked for
// it. DMs and group DMs go through their own tool, so they are out of reach here.

export interface SlackPostInput {
  sessionId: string;
  callId: string;
  requester: string | undefined;
  target: string;
  text: string;
}

type PostDeps = LedgerDeps & { usersEnv?: string | undefined };

export async function postToConversation(deps: PostDeps, input: SlackPostInput): Promise<string> {
  const text = input.text.trim().slice(0, POST_MAX);
  if (!text) return "The message is empty.";
  if (!deps.slack) return UNREACHABLE;
  const target = await resolveTarget(deps.slack, input.target).catch(() => undefined);
  if (!target || target.channel.startsWith("D")) return UNREACHABLE;
  const reached = await reachConversation(deps, input.requester, target.channel);
  if (!reached || reached.isDirect) return UNREACHABLE;
  const outcome = await postAndConfirm(deps, {
    key: `slack-post:${input.sessionId}:${input.callId}`,
    channel: target.channel,
    threadTs: target.threadTs ?? target.messageTs,
    text: `${text}\n\n_Posted for <@${input.requester}>_`,
  });
  if (outcome === "sent") return "Posted.";
  if (outcome === "pending") return "The post will appear once Slack accepts it.";
  return "I couldn't post there: Slack refused it.";
}

// A post that carries words out of a private conversation into another one waits for the
// requester's confirmation. Posting back into the same conversation never does.
export async function postNeedsConfirmation(
  deps: Pick<LedgerDeps, "sql" | "slack">,
  sessionId: string,
  target: string | undefined,
): Promise<boolean> {
  const source = await getSessionThread(deps.sql, sessionId);
  if (!source || !deps.slack) return true;
  const resolved = target
    ? await resolveTarget(deps.slack, target).catch(() => undefined)
    : undefined;
  if (resolved?.channel === source.channelId) return false;
  return isPrivateConversation(deps.slack, source.channelId);
}
