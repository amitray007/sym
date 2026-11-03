import type { Sql } from "../db.ts";
import type { Pack } from "../pack/load.ts";
import type { PackSchedule } from "../pack/schedules.ts";
import { nextFireOf, type Schedule } from "./rows.ts";

// Seeds the pack's schedules.yaml into the schedules table (decisions 055 and 085). The deployer
// wrote each entry, so a new row is active at once. Safe to run again: a row that matches its
// entry is left alone, and a row someone paused stays paused.

export interface SeedResult {
  // Rows this run added, changed, or revived.
  seeded: Schedule[];
  // Keys the pack no longer lists, now deleted.
  removed: string[];
}

export async function seedPackSchedules(
  sql: Sql,
  pack: Pack | undefined,
  now: Date,
): Promise<SeedResult> {
  // Without a pack, leave every row alone. A missing pack must not delete the owner's schedules.
  if (!pack) return { seeded: [], removed: [] };
  const owner = pack.config.owner.slackUserId;
  const existing = (await sql<Schedule[]>`select * from schedules where pack_key is not null`).map(
    normalize,
  );
  const byKey = new Map(existing.map((row) => [row.packKey as string, row]));
  const seeded: Schedule[] = [];

  for (const entry of pack.schedules) {
    const row = byKey.get(entry.key);
    if (row && row.status !== "deleted" && sameEntry(row, entry)) continue;
    const next = nextFireOf({ cron: entry.cron, runAt: null }, now);
    if (!next) throw new Error(`Pack schedule "${entry.key}": cron "${entry.cron}" never fires.`);
    const saved = row
      ? await updateRow(sql, row.id, entry, owner, next)
      : await insertRow(sql, entry, owner, next);
    if (saved) seeded.push(normalize(saved));
  }

  const listed = new Set(pack.schedules.map((entry) => entry.key));
  const removed: string[] = [];
  for (const row of existing) {
    if (listed.has(row.packKey as string) || row.status === "deleted") continue;
    await sql`
      update schedules set status = 'deleted', next_fire_at = null, lease_until = null
      where id = ${row.id}
    `;
    removed.push(row.packKey as string);
  }
  return { seeded, removed };
}

async function insertRow(sql: Sql, entry: PackSchedule, owner: string, next: Date) {
  const [row] = await sql<Schedule[]>`
    insert into schedules (cron, title, instruction, builder, channel, owner, pack_key, next_fire_at)
    values (
      ${entry.cron}, ${entry.title}, ${entry.instruction}, ${entry.builder}, ${entry.channel},
      ${owner}, ${entry.key}, ${next}
    )
    returning *
  `;
  return row;
}

// A deleted row comes back active. A paused row keeps its pause and gets its next fire on resume.
async function updateRow(sql: Sql, id: number, entry: PackSchedule, owner: string, next: Date) {
  const [row] = await sql<Schedule[]>`
    update schedules
    set cron = ${entry.cron}, title = ${entry.title}, instruction = ${entry.instruction},
      builder = ${entry.builder}, channel = ${entry.channel}, owner = ${owner},
      status = case when status = 'deleted' then 'active' else status end,
      next_fire_at = case when status = 'paused' then null else ${next}::timestamptz end,
      lease_until = null
    where id = ${id}
    returning *
  `;
  return row;
}

function sameEntry(row: Schedule, entry: PackSchedule): boolean {
  return (
    row.cron === entry.cron &&
    row.title === entry.title &&
    row.channel === entry.channel &&
    row.instruction === entry.instruction &&
    row.builder === entry.builder
  );
}

function normalize(row: Schedule): Schedule {
  return { ...row, id: Number(row.id) };
}
