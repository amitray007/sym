import { Brief } from "../jobs/brief.ts";
import { sameJson } from "./match.ts";
import type { Schedule } from "./rows.ts";

// Decision 024: a job skips the Start prompt only when the schedule app principal started the
// session, the schedule row is active, and the brief equals the approved one. Pure code: the
// caller loads the row and tells whether the session's initiator is the schedule principal.
export function canSkipStart(input: {
  isSchedulePrincipal: boolean;
  schedule: Pick<Schedule, "status" | "brief"> | undefined;
  brief: unknown;
}): boolean {
  const { schedule } = input;
  if (!input.isSchedulePrincipal || schedule?.status !== "active") return false;
  const approved = Brief.safeParse(schedule.brief);
  const given = Brief.safeParse(input.brief);
  if (!approved.success || !given.success) return false;
  return sameJson(approved.data, given.data);
}

// The approval prompt reads only the tool input, so schedule_approve repeats the cron and the
// brief, and this check refuses a call whose text differs from the stored row. The owner then
// approves exactly what will run.
export function sameAsStored(
  schedule: Pick<Schedule, "cron" | "brief">,
  shown: { cron: string; brief: unknown },
): boolean {
  const stored = Brief.safeParse(schedule.brief);
  const given = Brief.safeParse(shown.brief);
  return (
    stored.success &&
    given.success &&
    schedule.cron === shown.cron.trim() &&
    sameJson(stored.data, given.data)
  );
}
