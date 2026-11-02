import type { Pack } from "../pack/load.ts";
import { type SlackApi, SlackApiError } from "./api.ts";
import { isSlackUserAllowed } from "./guard.ts";

// Sym's reach into other Slack conversations (decision 081). A tool that acts outside the
// conversation it was asked in names its target by link, mention, ID, or #name, and acts only
// when the requester is allowed and both Sym and the requester are members. Every refusal reads
// the same, so it never tells a non-member whether a channel exists or what Sym can see there.

export const UNREACHABLE = "I can't reach that conversation.";

export interface SlackTarget {
  channel: string;
  // The thread a link points into, from its `thread_ts` query.
  threadTs?: string;
  // The message a link points at.
  messageTs?: string;
}

export interface ReachDeps {
  slack?: SlackApi | undefined;
  pack?: Pack | undefined;
  usersEnv?: string | undefined;
}

export interface Conversation {
  id: string;
  isPrivate: boolean;
  isDirect: boolean;
}

const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;
const TS = /^\d{10}\.\d{6}$/;

// A link, a channel mention, or a channel ID. A #name needs a lookup, so it gives undefined
// here; `resolveTarget` handles it.
export function parseSlackTarget(input: string): SlackTarget | undefined {
  const text = input.trim();
  const mention = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(text);
  if (mention?.[1]) return { channel: mention[1] };
  if (CHANNEL_ID.test(text)) return { channel: text };
  return parseLink(text.replace(/^<([^|>]*)(?:\|[^>]*)?>$/, "$1"));
}

function parseLink(text: string): SlackTarget | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !/(^|\.)slack\.com$/.test(url.hostname)) return undefined;
  if (url.pathname === "/app_redirect") return parseRedirect(url);
  const match = /^\/archives\/([CGD][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?\/?$/.exec(url.pathname);
  if (!match?.[1]) return undefined;
  const target: SlackTarget = { channel: match[1] };
  if (match[2] && match[3]) target.messageTs = `${match[2]}.${match[3]}`;
  const threadTs = url.searchParams.get("thread_ts");
  if (threadTs && TS.test(threadTs)) target.threadTs = threadTs;
  return target;
}

// Sym's own thread links (lib/jobs/names.ts) use Slack's app_redirect form.
function parseRedirect(url: URL): SlackTarget | undefined {
  const channel = url.searchParams.get("channel") ?? "";
  if (!CHANNEL_ID.test(channel)) return undefined;
  const messageTs = url.searchParams.get("message_ts");
  return messageTs && TS.test(messageTs) ? { channel, messageTs } : { channel };
}

// Parses the target, and looks a #name up among the channels Sym belongs to.
export async function resolveTarget(
  slack: SlackApi,
  input: string,
): Promise<SlackTarget | undefined> {
  const parsed = parseSlackTarget(input);
  if (parsed) return parsed;
  const name = /^#?([a-z0-9][a-z0-9._-]{0,79})$/.exec(input.trim().toLowerCase())?.[1];
  if (!name) return undefined;
  let cursor = "";
  do {
    const page = await slack.call("users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const channels = Array.isArray(page.channels) ? page.channels : [];
    for (const channel of channels as { id?: unknown; name?: unknown }[]) {
      if (channel.name === name && typeof channel.id === "string") return { channel: channel.id };
    }
    cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
  } while (cursor);
  return undefined;
}

// The conversation when the requester may act in it, else undefined. Never throws: a Slack
// error is a refusal, logged with its code only.
export async function reachConversation(
  deps: ReachDeps,
  requester: string | undefined,
  channel: string,
): Promise<Conversation | undefined> {
  if (!deps.slack) return undefined;
  if (!isSlackUserAllowed(deps.pack, deps.usersEnv ?? process.env.SYM_SLACK_USERS, requester)) {
    return undefined;
  }
  try {
    const conversation = await conversationInfo(deps.slack, channel);
    if (!conversation || conversation.archived || !conversation.member) return undefined;
    if (!(await isMember(deps.slack, channel, requester as string))) return undefined;
    return { id: channel, isPrivate: conversation.isPrivate, isDirect: conversation.isDirect };
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "unknown_error";
    console.warn(`Sym refused to reach a Slack conversation: ${code}.`);
    return undefined;
  }
}

// True when people outside a conversation cannot read it: a private channel, a DM, or a group
// DM. Unknown counts as private, so the safe path wins.
export async function isPrivateConversation(slack: SlackApi, channel: string): Promise<boolean> {
  try {
    const conversation = await conversationInfo(slack, channel);
    return !conversation || conversation.isPrivate || conversation.isDirect;
  } catch {
    return true;
  }
}

// True for a Slack Connect channel, shared with another organization. Unknown counts as shared.
export async function isExternalConversation(slack: SlackApi, channel: string): Promise<boolean> {
  try {
    return (await conversationInfo(slack, channel))?.isExternal ?? true;
  } catch {
    return true;
  }
}

interface ConversationInfo {
  isPrivate: boolean;
  isDirect: boolean;
  isExternal: boolean;
  archived: boolean;
  member: boolean;
}

async function conversationInfo(
  slack: SlackApi,
  channel: string,
): Promise<ConversationInfo | undefined> {
  const info = await slack.call("conversations.info", { channel });
  const found = info.channel as
    | {
        is_private?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        is_archived?: boolean;
        is_member?: boolean;
        is_ext_shared?: boolean;
        is_pending_ext_shared?: boolean;
      }
    | undefined;
  if (!found) return undefined;
  const isDirect = found.is_im === true || found.is_mpim === true;
  return {
    isPrivate: found.is_private !== false,
    isDirect,
    isExternal: found.is_ext_shared === true || found.is_pending_ext_shared === true,
    archived: found.is_archived === true,
    // Slack leaves is_member out of a DM's info; a DM Sym can read is one it is in.
    member: found.is_member === true || found.is_im === true,
  };
}

async function isMember(slack: SlackApi, channel: string, user: string): Promise<boolean> {
  let cursor = "";
  do {
    const page = await slack.call("conversations.members", {
      channel,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (Array.isArray(page.members) && page.members.includes(user)) return true;
    cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
  } while (cursor);
  return false;
}
