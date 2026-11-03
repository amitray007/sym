import { finishRun } from "../schedules/rows.ts";
import { creatorMayRun, type FireDeps, type FireResult, runsPerHour } from "./fire.ts";
import {
  endDeferred,
  type GitHubEventName,
  type GitHubFilter,
  type GitHubTriggerEvent,
  type LinearFilter,
  type LinearTriggerEvent,
  reserveTriggerRun,
  sourceTriggers,
  type Trigger,
  triggerRef,
} from "./rows.ts";

// GitHub and Linear triggers (docs/architecture.md, flow 2d; decision 091). Eve's GitHub and
// Linear channels verify each webhook and hand Sym the event. Sym matches it against the active
// triggers' filters in code, and reserves one deferred run per trigger and delivery. The channel
// hooks have no `to()`, so the next `dispatch` tick sends each run, within a minute, as the app
// principal; the run acts for the trigger's creator. Event text is untrusted data.

const TEXT_MAX = 2000;

export const GITHUB_OFF =
  "GitHub triggers are off: the owner connects a GitHub App first (GITHUB_APP_ID, " +
  "GITHUB_APP_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET).";
export const GITHUB_NO_REPOS =
  "GitHub triggers need the owner's repository list first (SYM_GITHUB_REPOS, or the pack's " +
  "githubRepositories). Ask the owner to add the repository.";
export const LINEAR_OFF =
  "Linear triggers are off: the owner connects a Linear app first (LINEAR_AGENT_ACCESS_TOKEN " +
  "and LINEAR_WEBHOOK_SECRET).";

const set = (value: string | undefined) => Boolean(value?.trim());

// Eve's GitHub channel reads these variables. Without all three, Sym leaves the channel off.
export function githubConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    set(env.GITHUB_APP_ID) && set(env.GITHUB_APP_PRIVATE_KEY) && set(env.GITHUB_WEBHOOK_SECRET)
  );
}

// Eve's Linear channel reads the webhook secret and an access token under any of these names.
export function linearConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const token =
    env.LINEAR_AGENT_ACCESS_TOKEN ??
    env.LINEAR_ACCESS_TOKEN ??
    env.LINEAR_API_KEY ??
    env.LINEAR_API_TOKEN;
  return set(env.LINEAR_WEBHOOK_SECRET) && set(token);
}

export const clip = (text: unknown): string | null => {
  if (typeof text !== "string" || !text.trim()) return null;
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;
};

const lower = (values: string[]) => values.map((value) => value.toLowerCase());

export function matchesGitHub(filter: GitHubFilter, event: GitHubTriggerEvent): boolean {
  if (filter.repository !== event.repository.toLowerCase()) return false;
  if (filter.events.length && !filter.events.includes(event.event)) return false;
  if (
    filter.actions.length &&
    !lower(filter.actions).includes((event.action ?? "").toLowerCase())
  ) {
    return false;
  }
  if (filter.label && !lower(event.labels).includes(filter.label.toLowerCase())) return false;
  return !filter.branch || filter.branch === event.branch;
}

export function matchesLinear(filter: LinearFilter, event: LinearTriggerEvent): boolean {
  if (filter.team && filter.team !== (event.team ?? "").toUpperCase()) return false;
  if (
    filter.actions.length &&
    !lower(filter.actions).includes((event.action ?? "").toLowerCase())
  ) {
    return false;
  }
  return !filter.label || lower(event.labels).includes(filter.label.toLowerCase());
}

// Fires every matching trigger once for this event. Never sends: the dispatcher does. The event
// key names the delivery; `aliases` name its signed content, so a redelivery under another
// delivery ID fires nothing (decision 091).
export async function fireSourceTriggers(
  deps: FireDeps,
  event: GitHubTriggerEvent | LinearTriggerEvent,
  eventKey: string,
  aliases: string[] = [],
): Promise<FireResult[]> {
  const results: FireResult[] = [];
  for (const trigger of await sourceTriggers(deps.sql, event.kind)) {
    const filter = trigger.sourceFilter;
    const matches =
      filter &&
      (event.kind === "github"
        ? "repository" in filter && matchesGitHub(filter, event)
        : !("repository" in filter) && matchesLinear(filter, event));
    if (!matches || !trigger.destination) continue;
    results.push({
      trigger: triggerRef(trigger.id),
      status: await fire(deps, trigger, event, eventKey, aliases),
    });
  }
  return results;
}

// Reserves the run, then checks the creator, so a redelivery finds a refused run and fires
// nothing (decision 088). A refused run fails and leaves the dispatcher's queue.
async function fire(
  deps: FireDeps,
  trigger: Trigger,
  event: GitHubTriggerEvent | LinearTriggerEvent,
  eventKey: string,
  aliases: string[],
): Promise<string> {
  const reserved = await reserveTriggerRun(deps.sql, {
    triggerId: trigger.id,
    eventKey,
    aliases,
    facts: event,
    target: { channelId: trigger.destination ?? "" },
    deferred: true,
    firedAt: deps.now ?? new Date(),
    maxPerHour: deps.maxPerHour ?? runsPerHour(),
  });
  if (reserved.status === "limited") {
    console.warn(`Skipped ${triggerRef(trigger.id)}: it reached its hourly run limit.`);
  }
  if (reserved.status !== "reserved") return reserved.status;
  if (!(await creatorMayRun(deps, trigger))) {
    console.warn(`Skipped ${triggerRef(trigger.id)}: its creator left the allow-list or channel.`);
    await finishRun(deps.sql, reserved.run.id, "failed");
    await endDeferred(deps.sql, reserved.run.id);
    return "creator_not_allowed";
  }
  return "deferred";
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const labelsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((label) => str(obj(label).name)).filter((name): name is string => Boolean(name))
    : [];

// The facts of a GitHub event. Eve's hooks give the event's object: the pull request, the issue,
// the check suite, or the comment, plus the action and the issue or pull request number.
export function githubFacts(input: {
  event: GitHubEventName;
  action: string | null;
  repository: string;
  sender: string | null;
  item: Json;
  number?: number | null;
}): GitHubTriggerEvent {
  const { item } = input;
  const base = {
    kind: "github" as const,
    event: input.event,
    action: input.action,
    repository: input.repository,
    sender: input.sender,
  };
  if (input.event === "check_suite") {
    const prs = Array.isArray(item.pull_requests) ? item.pull_requests : [];
    return {
      ...base,
      number: input.number ?? num(obj(prs[0]).number),
      title: null,
      url: str(item.url),
      labels: [],
      branch: str(item.head_branch),
      conclusion: str(item.conclusion),
      text: null,
    };
  }
  const comment = input.event === "issue_comment";
  return {
    ...base,
    number: input.number ?? num(item.number),
    title: comment ? null : str(item.title),
    url: str(item.html_url),
    labels: comment ? [] : labelsOf(item.labels),
    branch: input.event === "pull_request" ? str(obj(item.base).ref) : null,
    conclusion: null,
    text: clip(item.body),
  };
}

// The facts of a Linear issue webhook, from its verified payload.
export function linearFacts(raw: Json): LinearTriggerEvent {
  const data = obj(raw.data);
  const labels = labelsOf(data.labels);
  return {
    kind: "linear",
    action: str(raw.action),
    identifier: str(data.identifier),
    title: str(data.title),
    url: str(data.url) ?? str(raw.url),
    team: str(obj(data.team).key),
    state: str(obj(data.state).name),
    labels,
    text: clip(data.description),
  };
}
