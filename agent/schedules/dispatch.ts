import { defineSchedule } from "eve/schedules";
import { ledger } from "../../lib/runtime.ts";
import { dispatchMessage } from "../../lib/schedules/format.ts";
import { claimDueSchedules, completeClaim, recordRun } from "../../lib/schedules/rows.ts";
import slack from "../channels/slack.ts";

// Dynamic scheduling (docs/architecture.md, flow 2; decision 008; Eve's dynamic scheduling
// pattern). Every minute, claim the due rows and open a new Slack thread for each, so the
// session has a real channel and buttons and the job card work.
const LEASE_MS = 5 * 60_000;

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const sql = ledger();
        const now = new Date();
        for (const schedule of await claimDueSchedules(sql, now, LEASE_MS)) {
          try {
            // No root message: a scheduled run posts only when something needs attention, and
            // its first post opens the thread (decision 031).
            const session = await to(slack, { channelId: schedule.channel }).send(
              dispatchMessage(schedule),
              { auth: appAuth },
            );
            await recordRun(sql, {
              scheduleId: schedule.id,
              firedAt: now,
              sessionId: session.id,
            });
          } catch {
            await recordRun(sql, { scheduleId: schedule.id, firedAt: now, outcome: "failed" });
          }
          // Skip the missed fire on failure. A retry could double a fire that half worked.
          await completeClaim(sql, schedule, now);
        }
      })(),
    );
  },
});
