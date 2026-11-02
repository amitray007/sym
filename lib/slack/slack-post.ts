import type { LedgerDeps } from "../jobs/run.ts";
import { getSessionThread } from "../ledger/threads.ts";
import { findOwnPost, OVER_CAP, overHourlyCap, recordRequestedPost } from "./own-posts.ts";
import { POST_MAX, postAndConfirm } from "./post.ts";
import {
  isExternalConversation,
  isPrivateConversation,
  reachConversation,
  resolveTarget,
  UNREACHABLE,
} from "./reach.ts";

// Posts in another channel or thread on request (decisions 081 and 082). Sym posts in its own
// voice; the ledger records who asked. DMs and group DMs go through their own tool, so they are
// out of reach here.

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
  if (!deps.slack || !input.requester) return UNREACHABLE;
  const target = await resolveTarget(deps.slack, input.target).catch(() => undefined);
  if (!target || target.channel.startsWith("D")) return UNREACHABLE;
  const reached = await reachConversation(deps, input.requester, target.channel);
  if (!reached || reached.isDirect) return UNREACHABLE;
  if (await overHourlyCap(deps.sql, input.requester)) return OVER_CAP;
  const { outcome, ts } = await postAndConfirm(deps, {
    key: `slack-post:${input.sessionId}:${input.callId}`,
    channel: target.channel,
    threadTs: target.threadTs ?? target.messageTs,
    text,
  });
  if (ts) {
    await recordRequestedPost(deps.sql, {
      channelId: target.channel,
      messageTs: ts,
      requester: input.requester,
      sessionId: input.sessionId,
    });
  }
  if (outcome === "sent") return "Posted.";
  if (outcome === "pending") return "The post will appear once Slack accepts it.";
  return "I couldn't post there: Slack refused it.";
}

// Slack's broadcast tokens and user-group mentions, and their plain-text forms.
const BROADCAST = /<!(?:channel|here|everyone)\b|<!subteam\^|(?:^|\s)@(?:channel|here|everyone)\b/i;

export function hasBroadcastMention(text: string): boolean {
  return BROADCAST.test(text);
}

// The requester approves a post first when it pings a whole channel or group, when it goes to a
// Slack Connect channel, or when it carries words out of a private conversation into another
// one. Unknowns count as needing approval.
export async function postNeedsConfirmation(
  deps: Pick<LedgerDeps, "sql" | "slack">,
  sessionId: string,
  target: string | undefined,
  text: string | undefined,
): Promise<boolean> {
  if (hasBroadcastMention(text ?? "")) return true;
  const source = await getSessionThread(deps.sql, sessionId);
  if (!source || !deps.slack) return true;
  const resolved = target
    ? await resolveTarget(deps.slack, target).catch(() => undefined)
    : undefined;
  if (resolved && (await isExternalConversation(deps.slack, resolved.channel))) return true;
  if (resolved?.channel === source.channelId) return false;
  return isPrivateConversation(deps.slack, source.channelId);
}

// An edit follows the same rules, aimed at the channel of the post it changes.
export async function editNeedsConfirmation(
  deps: Pick<LedgerDeps, "sql" | "slack">,
  sessionId: string,
  requester: string | undefined,
  message: string | undefined,
  text: string | undefined,
): Promise<boolean> {
  const post = await findOwnPost(deps.sql, requester, sessionId, message);
  if (!post) return false;
  return postNeedsConfirmation(deps, sessionId, post.channelId, text);
}
