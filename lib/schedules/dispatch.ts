import type { Sql } from "../db.ts";
import { dispatchMessage } from "./format.ts";
import {
  attachSession,
  claimDueSchedules,
  completeClaim,
  finishRun,
  reserveRun,
  type Schedule,
  type ScheduleRun,
  scheduleRef,
  unsentRun,
} from "./rows.ts";

// One dispatcher tick (docs/architecture.md, flow 2; decisions 024 and 085). It claims the due
// rows and delivers one run message for each. The Eve schedule wires `send` to Slack.

export interface DispatchDeps {
  sql: Sql;
  now: Date;
  leaseMs: number;
  // True while the schedule's creator is on the allow-list.
  mayRun: (creator: string) => boolean;
  // Starts the run's session and returns its ID. The same key reaches the same session.
  send: (schedule: Schedule, message: string, idempotencyKey: string) => Promise<string>;
  warn?: (line: string) => void;
}

// How long a one-time run keeps retrying its delivery before it fails.
export const ONE_TIME_RETRY_MS = 60 * 60_000;

export const deliveryKey = (runId: number) => `sym-schedule-run:${runId}`;

export async function dispatchDue(deps: DispatchDeps): Promise<void> {
  for (const schedule of await claimDueSchedules(deps.sql, deps.now, deps.leaseMs)) {
    if (await fire(deps, schedule)) await completeClaim(deps.sql, schedule, deps.now);
  }
}

// False when a one-time run must try its delivery again once the lease runs out, so the row
// does not end as done before its one run reached Slack.
async function fire(deps: DispatchDeps, schedule: Schedule): Promise<boolean> {
  const { sql, now } = deps;
  const dueAt = schedule.nextFireAt;
  if (!dueAt) return true;
  const fresh = await reserveRun(sql, { scheduleId: schedule.id, dueAt, firedAt: now });
  const run = fresh ?? (await unsentRun(sql, schedule.id, dueAt));
  // This fire already reached Slack.
  if (!run) return true;
  if (!deps.mayRun(schedule.owner)) {
    deps.warn?.(`Skipped ${scheduleRef(schedule.id)}: its creator left the allow-list.`);
    await finishRun(sql, run.id, "failed");
    return true;
  }
  // A recurring fire that a crashed dispatcher left undelivered is skipped, not replayed.
  if (!fresh && schedule.cron) {
    await finishRun(sql, run.id, "failed");
    return true;
  }
  return deliver(deps, schedule, run);
}

async function deliver(deps: DispatchDeps, schedule: Schedule, run: ScheduleRun): Promise<boolean> {
  try {
    const sessionId = await deps.send(schedule, dispatchMessage(schedule), deliveryKey(run.id));
    await attachSession(deps.sql, run.id, sessionId);
    return true;
  } catch {
    const retrying =
      !schedule.cron && deps.now.getTime() - run.firedAt.getTime() < ONE_TIME_RETRY_MS;
    if (retrying) return false;
    await finishRun(deps.sql, run.id, "failed");
    return true;
  }
}
