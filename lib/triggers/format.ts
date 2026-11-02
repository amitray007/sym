import { runMessage } from "../schedules/format.ts";
import { type Trigger, type TriggerEvent, triggerRef } from "./rows.ts";

const INSTRUCTION_PREVIEW = 300;

// What fires the trigger, in words.
function firesOn(trigger: Trigger): string {
  if (trigger.kind === "reaction") return `a :${trigger.emoji}: reaction in <#${trigger.channel}>`;
  const words = trigger.keywords.length ? ` with ${trigger.keywords.join(", ")}` : "";
  return `a new message${words} in <#${trigger.channel}>`;
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

export function triggerList(triggers: Trigger[]): string {
  return triggers.length === 0 ? "There are no triggers." : triggers.map(details).join("\n");
}

function details(trigger: Trigger): string {
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
    `  Posts in ${postsIn(trigger)}. ${builder}.`,
    `  Does: ${preview}`,
  ].join("\n");
}

// The message that starts a trigger run (decision 088): the schedule run message with the
// event's facts as untrusted data and where the run posts.
export function triggerRunMessage(trigger: Trigger, event: TriggerEvent): string {
  const where = trigger.destination
    ? `This run's replies post in ${postsIn(trigger)}.`
    : "This run's replies post in the event message's thread.";
  return runMessage({
    ref: triggerRef(trigger.id),
    title: trigger.title,
    instruction: trigger.instruction,
    builder: trigger.builder,
    owner: trigger.owner,
    trigger: { event, destination: where },
  });
}
