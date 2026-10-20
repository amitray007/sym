import { defineSchedule } from "eve/schedules";
import { checkProject } from "../../lib/projects/allowed.ts";
import { allowedFromEnv, ledger, pack } from "../../lib/runtime.ts";
import { dispatchMessage } from "../../lib/schedules/format.ts";
import {
  attachSession,
  claimDueSchedules,
  completeClaim,
  finishRun,
  reserveRun,
} from "../../lib/schedules/rows.ts";
import { seedPackSchedules } from "../../lib/schedules/seed.ts";
import slack from "../channels/slack.ts";

// Dynamic scheduling (docs/architecture.md, flow 2; decision 008; Eve's dynamic scheduling
// pattern). Every minute, claim the due rows and open a new Slack thread for each, so the
// session has a real channel and buttons and the job card work.
const LEASE_MS = 5 * 60_000;

// Decision 055: seed the pack's schedules once per process, before the first claim. A failure
// clears the promise, so the next tick tries again.
let seeded: Promise<unknown> | undefined;
async function seedOnce(): Promise<void> {
  try {
    seeded ??= seedPackSchedules(ledger(), pack());
    await seeded;
  } catch (error) {
    seeded = undefined;
    console.warn(`Seeding the pack schedules failed: ${(error as Error).message}`);
  }
}

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const sql = ledger();
        await seedOnce();
        const now = new Date();
        for (const schedule of await claimDueSchedules(sql, now, LEASE_MS)) {
          // Persist the fire identity before the send. A crash after the send leaves the row,
          // so the next dispatcher skips the send and only completes the claim.
          const run = schedule.nextFireAt
            ? await reserveRun(sql, {
                scheduleId: schedule.id,
                dueAt: schedule.nextFireAt,
                firedAt: now,
              })
            : undefined;
          if (run) {
            // Decision 042: a schedule whose project left the list does not run. worker_job checks
            // again, so the brain cannot start it either.
            const project = (schedule.brief as { project?: unknown } | null)?.project;
            if (typeof project !== "string" || checkProject(allowedFromEnv(), project)) {
              await finishRun(sql, run.id, "failed");
              await completeClaim(sql, schedule, now);
              continue;
            }
            try {
              // No root message: a scheduled run posts only when something needs attention, and
              // its first post opens the thread (decision 031).
              const session = await to(slack, { channelId: schedule.channel }).send(
                dispatchMessage(schedule),
                { auth: appAuth },
              );
              await attachSession(sql, run.id, session.id);
            } catch {
              await finishRun(sql, run.id, "failed");
            }
          }
          // Skip the missed fire on failure. A retry could double a fire that half worked.
          await completeClaim(sql, schedule, now);
        }
      })(),
    );
  },
});
