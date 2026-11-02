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
import {
  createTrigger,
  type GitHubFilter,
  type LinearFilter,
  type SourceFilter,
  type Trigger,
} from "./rows.ts";
import { GITHUB_OFF, githubConfigured, LINEAR_OFF, linearConfigured } from "./sources.ts";
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
  if (input.on === "webhook" || input.on === "github" || input.on === "linear") {
    return setUpOffSlack(deps, input, env);
  }
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

// A webhook, GitHub, or Linear trigger (decisions 090 and 091) watches no Slack channel. Its
// runs post in this conversation, a DM with the person, or another channel the person and Sym
// share, as for schedules. Each run starts a new thread there, because the event has no Slack
// thread of its own.
async function setUpOffSlack(
  deps: SetupDeps,
  input: TriggerInput & { requester: string; current: string | undefined },
  env: NodeJS.ProcessEnv,
): Promise<{ trigger: Trigger } | { refusal: string }> {
  const source = sourceSetup(input, env);
  if ("refusal" in source) return source;
  const wanted = input.destination?.trim();
  const resolved = await scheduleDestination(deps, {
    requester: input.requester,
    current: input.current,
    destination: wanted && wanted.toLowerCase() !== "thread" ? wanted : undefined,
  });
  if ("refusal" in resolved) return resolved;
  const trigger = await createTrigger(deps.sql, {
    kind: input.on,
    channel: null,
    keywords: [],
    emoji: null,
    title: input.title,
    instruction: input.instruction,
    builder: input.builder,
    destination: resolved.channel,
    owner: input.requester,
    ...source,
  });
  return { trigger };
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// What the kind needs beyond a destination: a webhook's hook ID, or a GitHub or Linear filter.
// Each refuses while its service is not set up.
function sourceSetup(
  input: TriggerInput,
  env: NodeJS.ProcessEnv,
): { hookId?: string; sourceFilter?: SourceFilter } | { refusal: string } {
  const actions = (input.actions ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const label = input.label?.trim() || null;
  if (input.on === "webhook") {
    return webhookKey(env) ? { hookId: newHookId() } : { refusal: WEBHOOKS_OFF };
  }
  if (input.on === "github") {
    if (!githubConfigured(env)) return { refusal: GITHUB_OFF };
    const repository = input.repository?.trim().toLowerCase() ?? "";
    if (!REPOSITORY.test(repository)) return { refusal: "Name the repository as owner/name." };
    const filter: GitHubFilter = {
      repository,
      events: [...new Set(input.events ?? [])],
      actions,
      label,
      branch: input.branch?.trim() || null,
    };
    return { sourceFilter: filter };
  }
  if (!linearConfigured(env)) return { refusal: LINEAR_OFF };
  const filter: LinearFilter = {
    team: input.team?.trim().toUpperCase() || null,
    actions,
    label,
  };
  return { sourceFilter: filter };
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
