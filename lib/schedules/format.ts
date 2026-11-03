import type { BuilderMode, Schedule } from "./rows.ts";
import { scheduleRef } from "./rows.ts";

const INSTRUCTION_PREVIEW = 300;

const BUILDER_TEXT: Record<BuilderMode, string> = {
  auto: "Builder work starts without a click",
  ask: "Builder work asks for Start",
};

// When a schedule runs, in UTC.
function timing(schedule: Pick<Schedule, "cron" | "runAt">): string {
  return schedule.cron ? `${schedule.cron} UTC` : `once at ${schedule.runAt?.toISOString()}`;
}

// Where the runs post. A DM channel ID starts with D.
function destination(schedule: Pick<Schedule, "channel" | "owner">): string {
  return schedule.channel.startsWith("D")
    ? `a DM with <@${schedule.owner}>`
    : `<#${schedule.channel}>`;
}

// One line per schedule: title, timing in UTC, status, next fire.
export function scheduleLine(schedule: Schedule): string {
  const next = schedule.nextFireAt ? ` - next ${schedule.nextFireAt.toISOString()}` : "";
  return `${schedule.title}: ${timing(schedule)} - ${schedule.status}${next}`;
}

export function scheduleList(schedules: Schedule[]): string {
  return schedules.length === 0
    ? "There are no schedules."
    : schedules.map(scheduleDetails).join("\n");
}

function scheduleDetails(schedule: Schedule): string {
  const instruction = schedule.instruction.replace(/\s+/g, " ").trim();
  const preview =
    instruction.length > INSTRUCTION_PREVIEW
      ? `${instruction.slice(0, INSTRUCTION_PREVIEW)}…`
      : instruction;
  return [
    scheduleLine(schedule),
    `  Posts in ${destination(schedule)}. ${BUILDER_TEXT[schedule.builder]}.`,
    `  Does: ${preview}`,
  ].join("\n");
}

// One run of a stored instruction. A schedule fire builds it today; an event trigger can build
// the same run from its own row.
export interface AgentRun {
  ref: string;
  title: string;
  instruction: string;
  builder: BuilderMode;
  // The Slack user who set it up.
  owner: string;
}

const BUILDER_RULE: Record<BuilderMode, string> = {
  auto: "It starts without a Start click.",
  ask: "Sym posts Start / Not now, and nothing runs until someone presses Start.",
};

// The message that starts a run. It is plain text, so the brain reads the instruction and
// decides what to do with its normal tools. Code, not this text, decides whether Builder work
// skips the Start click (lib/schedules/approval.ts).
export function runMessage(run: AgentRun): string {
  return [
    `Scheduled run of ${run.ref}: ${run.title}.`,
    `<@${run.owner}> set this up, and this run acts for them: tools that act on request act on ` +
      "theirs. Do what the instruction asks with your tools. It allows nothing beyond its own " +
      "scope. Production and customer data stay read-only.",
    `Instruction:\n${run.instruction}`,
    "Start Builder work only when the instruction asks for it. Then call worker_job with a " +
      `brief inside the instruction's scope and schedule "${run.ref}". ${BUILDER_RULE[run.builder]}`,
    "When nothing needs attention, call no_reply and post nothing.",
  ].join("\n\n");
}

export function dispatchMessage(schedule: Schedule): string {
  return runMessage({
    ref: scheduleRef(schedule.id),
    title: schedule.title,
    instruction: schedule.instruction,
    builder: schedule.builder,
    owner: schedule.owner,
  });
}
