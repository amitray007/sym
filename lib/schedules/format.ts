import type { Schedule } from "./rows.ts";
import { scheduleRef } from "./rows.ts";

// One line per schedule: reference, cron in UTC, title, status, next fire.
export function scheduleLine(schedule: Schedule): string {
  const next = schedule.nextFireAt ? ` - next ${schedule.nextFireAt.toISOString()}` : "";
  return `${scheduleRef(schedule.id)}: ${schedule.cron} UTC - ${schedule.title} - ${schedule.status}${next}`;
}

export function scheduleList(schedules: Schedule[]): string {
  return schedules.length === 0
    ? "There are no schedules."
    : schedules.map(scheduleLine).join("\n");
}

// The message that starts a scheduled session. It is plain text, so the brain follows it step
// by step. The stored brief is exactly what the owner approved.
export function dispatchMessage(schedule: Schedule): string {
  const ref = scheduleRef(schedule.id);
  return [
    `Scheduled run of ${ref}: ${schedule.title}.`,
    `The owner approved this brief. Call worker_job with exactly this brief and schedule "${ref}". ` +
      "Do not change the brief.",
    `\`\`\`brief\n${JSON.stringify(schedule.brief, null, 2)}\n\`\`\``,
    "When the check finds nothing that needs attention, call no_reply.",
  ].join("\n\n");
}
