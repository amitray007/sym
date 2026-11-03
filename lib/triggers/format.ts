import { runMessage } from "../schedules/format.ts";
import { type RunTarget, type Trigger, type TriggerEvent, triggerRef } from "./rows.ts";

const INSTRUCTION_PREVIEW = 300;

// What fires the trigger, in words.
function firesOn(trigger: Trigger): string {
  if (trigger.kind === "webhook") return "a signed webhook request";
  if (trigger.kind === "github" || trigger.kind === "linear") return sourceEvents(trigger);
  if (trigger.kind === "reaction") return `a :${trigger.emoji}: reaction in <#${trigger.channel}>`;
  const words = trigger.keywords.length ? ` with ${trigger.keywords.join(", ")}` : "";
  return `a new message${words} in <#${trigger.channel}>`;
}

// A GitHub or Linear trigger's filter, in words (decision 091).
function sourceEvents(trigger: Trigger): string {
  const filter = trigger.sourceFilter;
  if (!filter) return `a ${trigger.kind} event`;
  const actions = filter.actions.length ? ` (${filter.actions.join(", ")})` : "";
  const label = filter.label ? ` labeled ${filter.label}` : "";
  if ("repository" in filter) {
    const events = filter.events.length ? filter.events.join(", ") : "any event";
    const branch = filter.branch ? ` on ${filter.branch}` : "";
    return `GitHub ${events}${actions}${label}${branch} in ${filter.repository}`;
  }
  const team = filter.team ? ` in team ${filter.team}` : "";
  return `a Linear issue change${actions}${label}${team}`;
}

// Where the runs post. A DM channel ID starts with D.
function postsIn(trigger: Pick<Trigger, "destination" | "owner">): string {
  if (!trigger.destination) return "the event message's thread";
  return trigger.destination.startsWith("D")
    ? `a DM with <@${trigger.owner}>`
    : `<#${trigger.destination}>`;
}

export function triggerLine(trigger: Trigger): string {
  return `${trigger.title}: on ${firesOn(trigger)} - ${trigger.status}`;
}

// `urlOf` gives a webhook trigger's URL. A list never shows a secret (decision 090).
export function triggerList(
  triggers: Trigger[],
  urlOf: (trigger: Trigger) => string | undefined = () => undefined,
): string {
  return triggers.length === 0
    ? "There are no triggers."
    : triggers.map((trigger) => details(trigger, urlOf(trigger))).join("\n");
}

function details(trigger: Trigger, url: string | undefined): string {
  const instruction = trigger.instruction.replace(/\s+/g, " ").trim();
  const preview =
    instruction.length > INSTRUCTION_PREVIEW
      ? `${instruction.slice(0, INSTRUCTION_PREVIEW)}…`
      : instruction;
  const builder =
    trigger.builder === "auto"
      ? "Builder work starts without a click"
      : "Builder work asks for Start";
  return [
    triggerLine(trigger),
    ...(url ? [`  URL: ${url}`] : []),
    `  Posts in ${postsIn(trigger)}. ${builder}.`,
    `  Does: ${preview}`,
  ].join("\n");
}

// The message that starts a trigger run (decisions 088 and 090): the schedule run message with
// the event's facts as untrusted data and where the run posts.
// `target` is where the session starts. A run moved out of a shared event thread says so.
export function triggerRunMessage(
  trigger: Trigger,
  event: TriggerEvent,
  target?: RunTarget,
): string {
  const channel = target?.channelId ?? trigger.destination;
  const where = target?.threadTs
    ? "This run's replies post in the event message's thread."
    : !channel
      ? "This run's replies post in the event message's thread."
      : channel === trigger.destination
        ? `This run's replies post in ${postsIn(trigger)}.`
        : `This run's replies post in a DM with <@${trigger.owner}>, because another run uses ` +
          "the event message's thread.";
  return runMessage({
    ref: triggerRef(trigger.id),
    title: trigger.title,
    instruction: trigger.instruction,
    builder: trigger.builder,
    owner: trigger.owner,
    trigger: { event, destination: where },
  });
}
