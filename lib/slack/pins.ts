import { type SlackApi, SlackApiError } from "./api.ts";
import {
  parseSlackTarget,
  type ReachDeps,
  reachConversation,
  resolveTarget,
  UNREACHABLE,
} from "./reach.ts";

// Pins and channel bookmarks on request (decision 084), under the decision 081 checks: an
// allowed requester, and both Sym and the requester are members of the channel.

export async function pinMessage(
  deps: ReachDeps,
  requester: string | undefined,
  link: string,
  pin: boolean,
): Promise<string> {
  const target = parseSlackTarget(link);
  if (!target?.messageTs) return "Give me a link to the message.";
  const reached = await reachConversation(deps, requester, target.channel);
  if (!reached || reached.isDirect) return UNREACHABLE;
  const code = await call(deps.slack as SlackApi, pin ? "pins.add" : "pins.remove", {
    channel: target.channel,
    timestamp: target.messageTs,
  });
  if (code === "ok") return pin ? "Pinned." : "Unpinned.";
  if (code === "already_pinned") return "It's already pinned.";
  if (code === "no_pin") return "It isn't pinned.";
  if (code === "not_pinnable") return "Slack doesn't let that message be pinned.";
  return "Slack refused. Do not retry.";
}

export async function addBookmark(
  deps: ReachDeps,
  requester: string | undefined,
  input: { target: string; title: string; url: string },
): Promise<string> {
  if (!isWebLink(input.url)) return "Give me an https link to bookmark.";
  if (!deps.slack) return UNREACHABLE;
  const target = await resolveTarget(deps.slack, input.target).catch(() => undefined);
  if (!target) return UNREACHABLE;
  const reached = await reachConversation(deps, requester, target.channel);
  if (!reached || reached.isDirect) return UNREACHABLE;
  const code = await call(deps.slack, "bookmarks.add", {
    channel_id: target.channel,
    title: input.title,
    type: "link",
    link: input.url,
  });
  if (code === "ok") return "Bookmarked.";
  if (code === "too_many_bookmarks") return "That channel has no room for more bookmarks.";
  if (code === "invalid_link") return "Slack doesn't accept that link.";
  return "Slack refused. Do not retry.";
}

function isWebLink(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

async function call(
  slack: SlackApi,
  method: string,
  body: Record<string, unknown>,
): Promise<string> {
  try {
    await slack.call(method, body);
    return "ok";
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "unknown_error";
    console.warn(`Sym could not finish ${method}: ${code}.`);
    return code;
  }
}
