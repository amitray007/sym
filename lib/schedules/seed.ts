import { createHash } from "node:crypto";
import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { json } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import type { Pack } from "../pack/load.ts";
import type { PackSchedule } from "../pack/schedules.ts";
import { ownerTarget } from "../workers/expiry.ts";
import { sameJson } from "./match.ts";
import type { Schedule } from "./rows.ts";

// Seeds the pack's schedules.yaml into the schedules table (decision 055). A pack never widens
// Sym's rules, so a new or changed row waits for the owner's approval (decision 024). Safe to
// run again: a row that matches its entry is left alone.

export interface SeedResult {
  // Rows now waiting for approval because of this run.
  pending: Schedule[];
  // Keys the pack no longer lists, now deleted.
  removed: string[];
}

export async function seedPackSchedules(sql: Sql, pack: Pack | undefined): Promise<SeedResult> {
  // Without a pack, leave every row alone. A missing pack must not delete the owner's schedules.
  if (!pack) return { pending: [], removed: [] };
  const owner = pack.config.owner.slackUserId;
  const existing = (await sql<Schedule[]>`select * from schedules where pack_key is not null`).map(
    normalize,
  );
  const byKey = new Map(existing.map((row) => [row.packKey as string, row]));
  const pending: Schedule[] = [];
  const removed: string[] = [];

  for (const entry of pack.schedules) {
    const row = byKey.get(entry.key);
    if (!row) {
      const [created] = await sql<Schedule[]>`
        insert into schedules (cron, title, brief, channel, owner, pack_key)
        values (
          ${entry.cron}, ${entry.title}, ${json(sql, entry.brief)}, ${entry.channel}, ${owner},
          ${entry.key}
        )
        returning *
      `;
      if (created) pending.push(normalize(created));
      continue;
    }
    if (row.status !== "deleted" && sameEntry(row, entry)) continue;
    // The old approval covered another brief, or the row was deleted. Ask again. The check
    // constraint on active rows needs the approval and the fire time cleared.
    const [reset] = await sql<Schedule[]>`
      update schedules
      set cron = ${entry.cron}, title = ${entry.title}, brief = ${json(sql, entry.brief)},
        channel = ${entry.channel}, owner = ${owner}, status = 'pending_approval',
        approved_by = null, approved_at = null, next_fire_at = null, lease_until = null
      where id = ${row.id}
      returning *
    `;
    if (reset) pending.push(normalize(reset));
  }

  const listed = new Set(pack.schedules.map((entry) => entry.key));
  for (const row of existing) {
    if (listed.has(row.packKey as string) || row.status === "deleted") continue;
    await sql`
      update schedules set status = 'deleted', next_fire_at = null, lease_until = null
      where id = ${row.id}
    `;
    removed.push(row.packKey as string);
  }

  await queueSeedNotice(sql, pack, pending);
  return { pending, removed };
}

function sameEntry(row: Schedule, entry: PackSchedule): boolean {
  return (
    row.cron === entry.cron &&
    row.title === entry.title &&
    row.channel === entry.channel &&
    sameJson(row.brief, entry.brief)
  );
}

function normalize(row: Schedule): Schedule {
  return { ...row, id: Number(row.id) };
}

export function seedNoticeText(pending: Schedule[]): string {
  const lines = pending.map((row) => `- ${row.title} - ${row.cron} UTC`);
  return [
    pending.length === 1
      ? "The pack added a schedule that waits for your approval:"
      : "The pack added schedules that wait for your approval:",
    ...lines,
    "To approve one, ask me to approve it by name.",
  ].join("\n");
}

// Tells the owner once. The key holds each pending row and a hash of its fields, so a run with
// no change queues nothing, and a changed brief asks again.
async function queueSeedNotice(sql: Sql, pack: Pack, pending: Schedule[]): Promise<void> {
  const target = ownerTarget(pack);
  if (pending.length === 0 || !target) return;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(pending.map((r) => [r.id, r.cron, r.title, r.channel, r.brief])))
    .digest("hex")
    .slice(0, 16);
  // Channel IDs start with C or G, DM IDs with D, and a user ID (U or W) opens a DM.
  const dm = /^[DUW]/.test(target);
  const display = chooseDisplay({
    kind: "schedule-seed",
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: pending.length + 2,
    surface: dm ? "dm" : "channel",
    quiet: false,
  });
  await enqueuePost(sql, {
    idempotencyKey: `schedule-seed:${fingerprint}`,
    method: "chat.postMessage",
    payload: { channel: target, text: seedNoticeText(pending) },
    display: dm ? { ...display, target: "dm" } : display,
  });
}
