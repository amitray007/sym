import { describe, expect, it } from "vitest";
import {
  approveSchedule,
  claimDueSchedules,
  completeClaim,
  createSchedule,
  deleteSchedule,
  finishRun,
  getSchedule,
  isApprovedBrief,
  listSchedules,
  parseScheduleRef,
  pauseSchedule,
  recordRun,
  resumeSchedule,
  runsSince,
} from "../lib/schedules/rows.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const brief = { project: "p", title: "On-call check", goal: "g", doneWhen: ["d"] };
const input = { cron: "0 9 * * *", title: "On-call check", brief, channel: "C1", owner: "U1" };
const T0 = new Date("2026-10-20T08:00:00Z");

describe.skipIf(!hasDatabase)("schedule rows", () => {
  const ledger = useLedger();
  const sql = async () => ledger.sql();

  it("creates a pending row that does not fire", async () => {
    const db = await sql();
    const row = await createSchedule(db, input);
    expect(row.status).toBe("pending_approval");
    expect(row.nextFireAt).toBeNull();
    expect(await claimDueSchedules(db, new Date("2030-01-01T00:00:00Z"), 1000)).toEqual([]);
  });

  it("rejects a bad cron", async () => {
    await expect(createSchedule(await sql(), { ...input, cron: "nope" })).rejects.toThrow(/cron/i);
  });

  it("runs the lifecycle: approve, pause, resume, delete", async () => {
    const db = await sql();
    const created = await createSchedule(db, input);
    const active = await approveSchedule(db, created.id, "U1", T0);
    expect(active?.status).toBe("active");
    expect(active?.approvedBy).toBe("U1");
    expect(active?.nextFireAt?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    // A second approval changes nothing.
    expect(await approveSchedule(db, created.id, "U2", T0)).toBeUndefined();

    const paused = await pauseSchedule(db, created.id);
    expect(paused?.status).toBe("paused");
    expect(paused?.nextFireAt).toBeNull();
    expect(await pauseSchedule(db, created.id)).toBeUndefined();

    const resumed = await resumeSchedule(db, created.id, new Date("2026-10-20T09:30:00Z"));
    expect(resumed?.nextFireAt?.toISOString()).toBe("2026-10-21T09:00:00.000Z");

    expect((await deleteSchedule(db, created.id))?.status).toBe("deleted");
    expect((await listSchedules(db)).some((row) => row.id === created.id)).toBe(false);
    expect((await getSchedule(db, created.id))?.status).toBe("deleted");
  });

  it("cannot approve a paused or deleted row", async () => {
    const db = await sql();
    const created = await createSchedule(db, input);
    await deleteSchedule(db, created.id);
    expect(await approveSchedule(db, created.id, "U1", T0)).toBeUndefined();
  });

  it("the database refuses an active row without an approver", async () => {
    const db = await sql();
    const created = await createSchedule(db, input);
    await expect(
      db`update schedules set status = 'active' where id = ${created.id}`,
    ).rejects.toThrow(/schedules_active_ready/);
  });

  it("claims a due row once, even with two concurrent claims", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Concurrent" });
    await approveSchedule(db, created.id, "U1", T0);
    const due = new Date("2026-10-20T09:00:30Z");
    const [a, b] = await Promise.all([
      claimDueSchedules(db, due, 60_000),
      claimDueSchedules(db, due, 60_000),
    ]);
    const claimed = [...a, ...b].filter((row) => row.id === created.id);
    expect(claimed).toHaveLength(1);
  });

  it("holds a lease, then lets the row go after it runs out", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Lease" });
    await approveSchedule(db, created.id, "U1", T0);
    const due = new Date("2026-10-20T09:00:00Z");
    const mine = (rows: { id: number }[]) => rows.filter((row) => row.id === created.id);
    expect(mine(await claimDueSchedules(db, due, 60_000))).toHaveLength(1);
    expect(mine(await claimDueSchedules(db, new Date("2026-10-20T09:00:30Z"), 60_000))).toEqual([]);
    expect(
      mine(await claimDueSchedules(db, new Date("2026-10-20T09:02:00Z"), 60_000)),
    ).toHaveLength(1);
  });

  it("completeClaim records the fire, clears the lease, and skips missed windows", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Complete", cron: "0 * * * *" });
    await approveSchedule(db, created.id, "U1", T0);
    // The dispatcher was down for hours: the next fire is the next hour after now, not a backlog.
    const now = new Date("2026-10-20T13:20:00Z");
    const [claimed] = (await claimDueSchedules(db, now, 60_000)).filter((r) => r.id === created.id);
    if (!claimed) throw new Error("expected a claim");
    await completeClaim(db, claimed, now);
    const after = await getSchedule(db, created.id);
    expect(after?.leaseUntil).toBeNull();
    expect(after?.lastFiredAt?.toISOString()).toBe(now.toISOString());
    expect(after?.nextFireAt?.toISOString()).toBe("2026-10-20T14:00:00.000Z");
  });

  it("completeClaim leaves a row paused during the fire paused", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Pause mid-fire" });
    await approveSchedule(db, created.id, "U1", T0);
    const now = new Date("2026-10-20T09:00:00Z");
    const [claimed] = (await claimDueSchedules(db, now, 60_000)).filter((r) => r.id === created.id);
    if (!claimed) throw new Error("expected a claim");
    await pauseSchedule(db, created.id);
    await completeClaim(db, claimed, now);
    const after = await getSchedule(db, created.id);
    expect(after?.status).toBe("paused");
    expect(after?.nextFireAt).toBeNull();
  });

  it("records runs and their outcome", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Runs" });
    const run = await recordRun(db, { scheduleId: created.id, firedAt: T0, sessionId: "s1" });
    expect(run.outcome).toBe("started");
    await finishRun(db, run.id, "all_clear");
    const runs = (await runsSince(db, new Date("2026-10-20T00:00:00Z"))).filter(
      (r) => r.scheduleId === created.id,
    );
    expect(runs.map((r) => [r.sessionId, r.outcome])).toEqual([["s1", "all_clear"]]);
  });

  it("isApprovedBrief matches only the approved brief of an active row", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Approved" });
    expect(await isApprovedBrief(db, created.id, brief)).toBe(false);
    await approveSchedule(db, created.id, "U1", T0);
    expect(
      await isApprovedBrief(db, created.id, {
        doneWhen: ["d"],
        goal: "g",
        title: "On-call check",
        project: "p",
      }),
    ).toBe(true);
    expect(await isApprovedBrief(db, created.id, { ...brief, goal: "write code" })).toBe(false);
    await pauseSchedule(db, created.id);
    expect(await isApprovedBrief(db, created.id, brief)).toBe(false);
  });
});

describe("parseScheduleRef", () => {
  it("reads S-3 and 3", () => {
    expect(parseScheduleRef("S-3")).toBe(3);
    expect(parseScheduleRef(" 3 ")).toBe(3);
    expect(parseScheduleRef("J-3")).toBeUndefined();
  });
});
