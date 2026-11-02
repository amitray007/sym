import { describe, expect, it } from "vitest";
import type { Pack } from "../lib/pack/load.ts";
import type { PackSchedule } from "../lib/pack/schedules.ts";
import { getSchedule, listSchedules, pauseSchedule } from "../lib/schedules/rows.ts";
import { seedPackSchedules } from "../lib/schedules/seed.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const entry = (over: Partial<PackSchedule> = {}): PackSchedule => ({
  key: "weekday-check",
  title: "Weekday check",
  cron: "0 9 * * 1-5",
  channel: "C0EXAMPLE",
  instruction: "Look for failing checks on example-app and list each one.",
  builder: "ask",
  ...over,
});

const packWith = (...schedules: PackSchedule[]): Pack =>
  ({
    dir: "/pack",
    config: { owner: { slackUserId: "U0OWNER01" } },
    instructions: [],
    playbooks: [],
    schedules,
  }) as unknown as Pack;

describe.skipIf(!hasDatabase)("seedPackSchedules", () => {
  const ledger = useLedger();
  // A Tuesday.
  const now = new Date("2026-10-20T08:00:00Z");

  const theRow = async () => {
    const row = (await ledger.sql()`select id from schedules where pack_key = 'weekday-check'`)[0];
    const found = row ? await getSchedule(ledger.sql(), Number(row.id)) : undefined;
    if (!found) throw new Error("no schedule row");
    return found;
  };

  it("inserts a new key as active, owned by the pack owner, and posts nothing", async () => {
    const result = await seedPackSchedules(ledger.sql(), packWith(entry()), now);
    expect(result.seeded).toHaveLength(1);
    expect(result.seeded[0]).toMatchObject({
      status: "active",
      packKey: "weekday-check",
      owner: "U0OWNER01",
      channel: "C0EXAMPLE",
      builder: "ask",
      instruction: entry().instruction,
    });
    expect(result.seeded[0]?.nextFireAt?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(await ledger.sql()`select * from outbox`).toHaveLength(0);
  });

  it("leaves an unchanged row alone", async () => {
    const again = await seedPackSchedules(ledger.sql(), packWith(entry()), now);
    expect(again.seeded).toEqual([]);
  });

  it.each([
    { cron: "0 10 * * *" },
    { title: "Daily check" },
    { channel: "C0OTHER01" },
    { instruction: "Look wider." },
    { builder: "auto" as const },
  ])("updates an active row when %j changes and keeps it active", async (over) => {
    const sql = ledger.sql();
    const row = await theRow();
    const result = await seedPackSchedules(sql, packWith(entry(over)), now);
    expect(result.seeded.map((r) => r.id)).toEqual([row.id]);
    expect(await getSchedule(sql, row.id)).toMatchObject({ status: "active", ...over });
    await seedPackSchedules(sql, packWith(entry()), now);
  });

  it("keeps a row someone paused paused when its entry changes", async () => {
    const sql = ledger.sql();
    const row = await theRow();
    await pauseSchedule(sql, row.id);
    await seedPackSchedules(sql, packWith(entry({ instruction: "Look wider." })), now);
    expect(await getSchedule(sql, row.id)).toMatchObject({
      status: "paused",
      nextFireAt: null,
      instruction: "Look wider.",
    });
    await sql`update schedules set status = 'active', next_fire_at = ${now} where id = ${row.id}`;
  });

  it("deletes a key that left the pack, and revives it as active", async () => {
    const sql = ledger.sql();
    const row = await theRow();

    const gone = await seedPackSchedules(sql, packWith(), now);
    expect(gone.removed).toEqual(["weekday-check"]);
    expect((await getSchedule(sql, row.id))?.status).toBe("deleted");

    const back = await seedPackSchedules(sql, packWith(entry()), now);
    expect(back.seeded.map((r) => r.id)).toEqual([row.id]);
    expect((await getSchedule(sql, row.id))?.status).toBe("active");
  });

  it("changes nothing without a pack", async () => {
    const sql = ledger.sql();
    const before = await listSchedules(sql);
    expect(await seedPackSchedules(sql, undefined, now)).toEqual({ seeded: [], removed: [] });
    expect(await listSchedules(sql)).toEqual(before);
  });
});
