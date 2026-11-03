import { defineSchedule } from "eve/schedules";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";
import { dispatchDue } from "../../lib/schedules/dispatch.ts";
import { seedPackSchedules } from "../../lib/schedules/seed.ts";
import { isSlackUserAllowed } from "../../lib/slack/guard.ts";
import { sendDeferredRuns } from "../../lib/triggers/fire.ts";
import slack from "../channels/slack.ts";

// Dynamic scheduling (docs/architecture.md, flow 2; decision 008; Eve's dynamic scheduling
// pattern). Every minute, deliver the due rows (lib/schedules/dispatch.ts), each into a new
// Slack session, so the session has a real channel and buttons and the job card work.
const LEASE_MS = 5 * 60_000;

// Decision 055: seed the pack's schedules once per process, before the first claim. A failure
// clears the promise, so the next tick tries again.
let seeded: Promise<unknown> | undefined;
async function seedOnce(now: Date): Promise<void> {
  try {
    seeded ??= seedPackSchedules(ledger(), pack(), now);
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
        const now = new Date();
        await seedOnce(now);
        await dispatchDue({
          sql: ledger(),
          now,
          leaseMs: LEASE_MS,
          mayRun: (creator) =>
            isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, creator, () => {}),
          // No root message: a scheduled run posts only when something needs attention, and its
          // first post opens the thread (decision 031). The app principal marks the session as a
          // run; the run acts for its creator (decision 085).
          send: async (schedule, message, idempotencyKey) =>
            (
              await to(slack, { channelId: schedule.channel }).send(message, {
                auth: appAuth,
                idempotencyKey,
              })
            ).sessionId,
          warn: console.warn,
        });
        // Decision 088: a message trigger that posts outside the message's thread waits here,
        // because the message handler can start a session only in that thread. It uses the same
        // idempotent send, send mark, and locked attach as a scheduled run.
        await sendDeferredRuns(
          { sql: ledger(), slack: slackFromEnv(), pack: pack(), now },
          async ({ message, target, key, title }) =>
            (await to(slack, target).send(message, { auth: appAuth, idempotencyKey: key, title }))
              .sessionId,
        ).catch((error: unknown) => {
          console.warn(`Sending the deferred trigger runs failed: ${(error as Error).message}`);
        });
      })(),
    );
  },
});
