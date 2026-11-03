import type { SlackApi } from "../slack/api.ts";
import {
  parseSlackTarget,
  type ReachDeps,
  reachConversation,
  resolveTarget,
  UNREACHABLE,
} from "../slack/reach.ts";

// Where a new schedule's runs post (decision 085): this conversation's channel by default, a DM
// with the person who set it up, or another channel that person and Sym both belong to
// (decision 081). A DM resolves to its channel ID now, so the row stores one channel.

export type Destination = { channel: string } | { refusal: string };

export async function scheduleDestination(
  deps: ReachDeps,
  input: { requester: string; current: string | undefined; destination: string | undefined },
): Promise<Destination> {
  const wanted = input.destination?.trim();
  if (!wanted) {
    return input.current ? { channel: input.current } : { refusal: "Name a channel for the runs." };
  }
  if (wanted.toLowerCase() === "dm") return openDm(deps.slack, input.requester);
  const target = deps.slack
    ? await resolveTarget(deps.slack, wanted).catch(() => undefined)
    : parseSlackTarget(wanted);
  if (!target) return { refusal: UNREACHABLE };
  if (target.channel === input.current) return { channel: target.channel };
  const reached = await reachConversation(deps, input.requester, target.channel);
  return reached ? { channel: reached.id } : { refusal: UNREACHABLE };
}

async function openDm(slack: SlackApi | undefined, user: string): Promise<Destination> {
  const opened = await slack?.call("conversations.open", { users: user }).catch(() => undefined);
  const channel = (opened?.channel as { id?: unknown } | undefined)?.id;
  return typeof channel === "string" ? { channel } : { refusal: "I couldn't open a DM with you." };
}
