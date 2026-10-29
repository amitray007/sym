import { describe, expect, it } from "vitest";
import type { Pack } from "../lib/pack/load.ts";
import type { PackSchedule } from "../lib/pack/schedules.ts";
import { sameAsStored } from "../lib/schedules/approval.ts";
import { scheduleList } from "../lib/schedules/format.ts";
import { approveSchedule, getSchedule, listSchedules } from "../lib/schedules/rows.ts";
import { seedPackSchedules } from "../lib/schedules/seed.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const brief = {
  project: "example-app",
  title: "Weekday check",
  goal: "Look for failing checks.",
  constraints: [],
  doneWhen: ["The report lists each failure"],
  openPullRequest: false,
  estimatedMinutes: 15,
};

const entry = (over: Partial<PackSchedule> = {}): PackSchedule => ({
  key: "weekday-check",
  title: "Weekday check",
  cron: "0 9 * * 1-5",
  channel: "C0EXAMPLE",
  brief,
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
  const now = new Date("2026-10-21T08:00:00Z");

  const notices = () =>
    ledger.sql()`select * from outbox where idempotency_key like 'schedule-seed:%'`;
  const theRow = async () => {
    const row = (await listSchedules(ledger.sql()))[0];
    if (!row) throw new Error("no schedule row");
    return row;
  };

  it("inserts a new key as pending and tells the owner once", async () => {
    const result = await seedPackSchedules(ledger.sql(), packWith(entry()));
    expect(result.pending).toHaveLength(1);
    const row = result.pending[0];
    expect(row).toMatchObject({
      status: "pending_approval",
      packKey: "weekday-check",
      owner: "U0OWNER01",
      channel: "C0EXAMPLE",
    });

    const posts = await notices();
    expect(posts).toHaveLength(1);
    const payload = posts[0]?.payload as { channel: string; text: string };
    expect(payload.channel).toBe("U0OWNER01");
    expect(payload.text).toContain(`S-${row?.id}: Weekday check - 0 9 * * 1-5 UTC`);
    expect(payload.text).toContain("approve");
    expect(posts[0]?.display).toMatchObject({ target: "dm" });
  });

  it("leaves an approved, unchanged row alone and posts nothing new", async () => {
    const sql = ledger.sql();
    const row = await theRow();
    await approveSchedule(sql, row.id, "U0OWNER01", now);

    const again = await seedPackSchedules(sql, packWith(entry()));
    expect(again.pending).toEqual([]);
    expect((await getSchedule(sql, row.id))?.status).toBe("active");
    expect(await notices()).toHaveLength(1);
  });

  it("puts a changed brief back to pending, clears the approval, and asks once", async () => {
    const sql = ledger.sql();
    const row = await theRow();
    const changed = entry({ brief: { ...brief, goal: "Look wider." } });

    const result = await seedPackSchedules(sql, packWith(changed));
    expect(result.pending.map((r) => r.id)).toEqual([row.id]);
    expect(await getSchedule(sql, row.id)).toMatchObject({
      status: "pending_approval",
      approvedBy: null,
      approvedAt: null,
      nextFireAt: null,
      brief: { goal: "Look wider." },
    });
    expect(await notices()).toHaveLength(2);

    await seedPackSchedules(sql, packWith(changed));
    expect(await notices()).toHaveLength(2);
  });

  it.each([{ cron: "0 10 * * *" }, { title: "Daily check" }, { channel: "C0OTHER01" }])(
    "resets an approved row when %j changes",
    async (over) => {
      const sql = ledger.sql();
      const row = await theRow();
      const base = entry({ brief: { ...brief, goal: "Look wider." } });
      await seedPackSchedules(sql, packWith(base));
      await approveSchedule(sql, row.id, "U0OWNER01", now);

      const result = await seedPackSchedules(sql, packWith({ ...base, ...over }));
      expect(result.pending.map((r) => r.id)).toEqual([row.id]);
      expect((await getSchedule(sql, row.id))?.status).toBe("pending_approval");
      // Back to the stored base, so the next case starts from it.
      await seedPackSchedules(sql, packWith(base));
    },
  );

  it("deletes a key that left the pack, and revives it as pending", async () => {
    const sql = ledger.sql();
    const row = await theRow();
    const kept = entry({
      cron: row.cron,
      title: row.title,
      channel: row.channel,
      brief: row.brief as PackSchedule["brief"],
    });

    const gone = await seedPackSchedules(sql, packWith());
    expect(gone.removed).toEqual(["weekday-check"]);
    expect((await getSchedule(sql, row.id))?.status).toBe("deleted");

    const back = await seedPackSchedules(sql, packWith(kept));
    expect(back.pending.map((r) => r.id)).toEqual([row.id]);
    expect((await getSchedule(sql, row.id))?.status).toBe("pending_approval");
  });

  it("changes nothing without a pack", async () => {
    const sql = ledger.sql();
    const before = await listSchedules(sql);
    expect(await seedPackSchedules(sql, undefined)).toEqual({ pending: [], removed: [] });
    expect(await listSchedules(sql)).toEqual(before);
  });

  it("lists a pending row with its brief, and approval needs the same text", async () => {
    const row = await theRow();
    expect(row.status).toBe("pending_approval");
    const text = scheduleList([row]);
    expect(text).not.toContain("schedule_approve");
    expect(text).not.toContain('"goal"');

    const shown = { cron: row.cron, brief: row.brief };
    expect(sameAsStored(row, shown)).toBe(true);
    expect(sameAsStored(row, { ...shown, brief: { ...brief, goal: "Something else." } })).toBe(
      false,
    );
    expect(sameAsStored(row, { ...shown, cron: "* * * * *" })).toBe(false);
  });
});
