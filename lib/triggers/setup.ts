import type { Sql } from "../db.ts";
import { scheduleDestination } from "../schedules/destination.ts";
import {
  parseSlackTarget,
  type ReachDeps,
  reachConversation,
  resolveTarget,
} from "../slack/reach.ts";
import type { TriggerInput } from "./input.ts";
import { normalizeEmoji } from "./match.ts";
import { createTrigger, type Trigger } from "./rows.ts";
import { newHookId, WEBHOOKS_OFF, webhookKey } from "./webhook.ts";

// Sets up an event trigger (decision 088). Slack sends Sym events only from channels it is in,
// so the watched channel must be one that the person and Sym both belong to, checked the way the
// reach tools check it (decision 081). The refusal reads the same either way, so it never says
// whether a channel exists.

export const NOT_WATCHABLE =
  "I can't watch that channel. I can watch only a channel that you and I are both in, because " +
  "Slack sends me events only from channels I'm in. Invite me there first if I'm not.";

export const TRIGGER_NOT_ALLOWED = "Only people on Sym's allow-list can set up or change triggers.";

type SetupDeps = ReachDeps & { sql: Sql };

export async function setUpTrigger(
  deps: SetupDeps,
  input: TriggerInput & { requester: string; current: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ trigger: Trigger } | { refusal: string }> {
  if (input.on === "webhook") return setUpWebhook(deps, input, env);
  const emoji = input.emoji ? normalizeEmoji(input.emoji) : "";
  if (input.on === "reaction" && !emoji) return { refusal: "Name the emoji to watch for." };
  const watched = await watchedChannel(deps, input.channel, input.current);
  if (!watched) return { refusal: NOT_WATCHABLE };
  const reached = await reachConversation(deps, input.requester, watched);
  if (!reached || reached.isDirect) return { refusal: NOT_WATCHABLE };
  const wanted = input.destination?.trim();
  let destination: string | null = null;
  if (wanted && wanted.toLowerCase() !== "thread") {
    const resolved = await scheduleDestination(deps, {
      requester: input.requester,
      current: watched,
      destination: wanted,
    });
    if ("refusal" in resolved) return resolved;
    destination = resolved.channel;
  }
  const trigger = await createTrigger(deps.sql, {
    kind: input.on,
    channel: watched,
    keywords: input.on === "message" ? input.keywords.map((k) => k.trim()).filter(Boolean) : [],
    emoji: input.on === "reaction" ? emoji : null,
    title: input.title,
    instruction: input.instruction,
    builder: input.builder,
    destination,
    owner: input.requester,
  });
  return { trigger };
}

// A webhook trigger (decision 090) watches no channel. Its runs post in this conversation, a DM
// with the person, or another channel the person and Sym share, as for schedules. Each run
// starts a new thread there, because a request has no Slack thread of its own.
async function setUpWebhook(
  deps: SetupDeps,
  input: TriggerInput & { requester: string; current: string | undefined },
  env: NodeJS.ProcessEnv,
): Promise<{ trigger: Trigger } | { refusal: string }> {
  if (!webhookKey(env)) return { refusal: WEBHOOKS_OFF };
  const wanted = input.destination?.trim();
  const resolved = await scheduleDestination(deps, {
    requester: input.requester,
    current: input.current,
    destination: wanted && wanted.toLowerCase() !== "thread" ? wanted : undefined,
  });
  if ("refusal" in resolved) return resolved;
  const trigger = await createTrigger(deps.sql, {
    kind: "webhook",
    channel: null,
    keywords: [],
    emoji: null,
    title: input.title,
    instruction: input.instruction,
    builder: input.builder,
    destination: resolved.channel,
    owner: input.requester,
    hookId: newHookId(),
  });
  return { trigger };
}

// The named channel, or this conversation's channel. A DM cannot be watched.
async function watchedChannel(
  deps: SetupDeps,
  named: string | undefined,
  current: string | undefined,
): Promise<string | undefined> {
  const wanted = named?.trim();
  let channel = current;
  if (wanted) {
    const target = deps.slack
      ? await resolveTarget(deps.slack, wanted).catch(() => undefined)
      : parseSlackTarget(wanted);
    channel = target?.channel;
  }
  return channel && /^[CG][A-Z0-9]+$/.test(channel) ? channel : undefined;
}
