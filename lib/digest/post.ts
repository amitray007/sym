import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { recentJobs } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import { runsSince } from "../schedules/rows.ts";
import { digestMessage } from "./format.ts";

export const DEFAULT_DIGEST_CRON = "0 17 * * *";

// Builds the day's digest and puts it in the outbox. The key holds the day, so a second run on
// the same day posts nothing new. `channel` is a channel ID or the owner's user ID for a DM.
// Returns whether a post was queued.
export async function queueDigest(sql: Sql, channel: string, now: Date): Promise<boolean> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const day = dayStart.toISOString().slice(0, 10);

  const titles = await sql<{ id: number; title: string }[]>`select id, title from schedules`;
  const titleOf = new Map(titles.map((row) => [Number(row.id), row.title]));
  const text = digestMessage({
    day,
    jobs: await recentJobs(sql, dayStart),
    runs: (await runsSince(sql, dayStart)).map((run) => ({
      title: titleOf.get(run.scheduleId) ?? `Schedule ${run.scheduleId}`,
      outcome: run.outcome,
    })),
  });
  if (!text) return false;

  // Channel IDs start with C or G, DM IDs with D, and a user ID (U or W) opens a DM.
  const dm = /^[DUW]/.test(channel);
  const display = chooseDisplay({
    kind: "digest",
    needsAction: false,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: text.split("\n").length,
    surface: dm ? "dm" : "channel",
    quiet: false,
  });
  await enqueuePost(sql, {
    idempotencyKey: `digest:${day}`,
    method: "chat.postMessage",
    payload: { channel, text },
    display: dm ? { ...display, target: "dm" } : display,
  });
  return true;
}
