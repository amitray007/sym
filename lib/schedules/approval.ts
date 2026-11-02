import type { Schedule } from "./rows.ts";

// Decision 085: a scheduled run starts Builder work without a click only when the schedule app
// principal started the session and the schedule's builder mode is `auto`. The row must still
// be active, or `done` for a one-time row whose fire started this run. Pure code: the caller
// loads the row, checks the project, and binds the job to this session's run. An event
// trigger's row passes the same check (decision 088); a trigger is never `done`.
export function canSkipStart(input: {
  isSchedulePrincipal: boolean;
  schedule: Pick<Schedule, "status" | "builder"> | undefined;
}): boolean {
  const { schedule } = input;
  if (!input.isSchedulePrincipal || schedule?.builder !== "auto") return false;
  return schedule.status === "active" || schedule.status === "done";
}
