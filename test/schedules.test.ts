import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../lib/ledger/migrate.ts";
import type { Schedule } from "../lib/schedules/rows.ts";
import {
  attachSession,
  claimDueSchedules,
  claimRunForJob,
  claimRunWhenAttached,
  completeClaim,
  createSchedule,
  deleteSchedule,
  finishRun,
  finishRunForSession,
  getSchedule,
  listSchedules,
  parseScheduleRef,
  pauseSchedule,
  recordRun,
  reserveRun,
  resumeSchedule,
  runsSince,
  ScheduleTimingError,
} from "../lib/schedules/rows.ts";
import { scheduleRunsMigration } from "../lib/schedules/runs-migration.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const input = {
  cron: "0 9 * * *",
  title: "On-call check",
  instruction: "Check the on-call dashboard.",
  builder: "ask" as const,
  channel: "C1",
  owner: "U1",
};
const T0 = new Date("2026-10-20T08:00:00Z");

describe.skipIf(!hasDatabase)("schedule rows", () => {
  const ledger = useLedger();
  const sql = async () => ledger.sql();
  // No-op once the ledger registers the migration.
  beforeAll(async () => {
    await migrate(ledger.sql(), [scheduleRunsMigration]);
  });

  const newJob = async (key: string) => {
    const [job] = await ledger.sql()<{ id: string }[]>`
      insert into jobs (request_key, kind, title, brief, worker)
      values (${key}, 'code-change', 't', '{}', 't3') returning id
    `;
    return Number(job?.id);
  };

  it("creates an active row with its first fire, no approval needed", async () => {
    const db = await sql();
    const row = await createSchedule(db, input, T0);
    expect(row).toMatchObject({ status: "active", builder: "ask", runAt: null });
    expect(row.nextFireAt?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
  });

  it("rejects a bad cron, a cron that never fires, and a past one-time run", async () => {
    const db = await sql();
    await expect(createSchedule(db, { ...input, cron: "nope" }, T0)).rejects.toThrow(/cron/i);
    await expect(createSchedule(db, { ...input, cron: "0 0 31 2 *" }, T0)).rejects.toThrow(
      ScheduleTimingError,
    );
    const { cron: _cron, ...once } = input;
    await expect(
      createSchedule(db, { ...once, runAt: new Date("2026-10-20T07:00:00Z") }, T0),
    ).rejects.toThrow("That time has passed.");
  });

  it("runs the lifecycle: pause, resume, delete", async () => {
    const db = await sql();
    const created = await createSchedule(db, input, T0);

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

  it("the database refuses an active row without a next fire, and both or neither timing", async () => {
    const db = await sql();
    const created = await createSchedule(db, input, T0);
    await expect(
      db`update schedules set next_fire_at = null where id = ${created.id}`,
    ).rejects.toThrow(/schedules_active_ready/);
    await expect(db`update schedules set run_at = now() where id = ${created.id}`).rejects.toThrow(
      /schedules_timing/,
    );
    await expect(db`update schedules set cron = null where id = ${created.id}`).rejects.toThrow(
      /schedules_timing/,
    );
  });

  it("fires a one-time row once, then it is done", async () => {
    const db = await sql();
    const { cron: _cron, ...once } = input;
    const runAt = new Date("2026-10-20T15:00:00Z");
    const created = await createSchedule(db, { ...once, title: "Reminder", runAt }, T0);
    expect(created).toMatchObject({ cron: null, status: "active" });
    expect(created.nextFireAt?.toISOString()).toBe(runAt.toISOString());

    const mine = (rows: Schedule[]) => rows.filter((row) => row.id === created.id);
    expect(mine(await claimDueSchedules(db, new Date("2026-10-20T14:59:00Z"), 60_000))).toEqual([]);
    const now = new Date("2026-10-20T15:00:20Z");
    const [claimed] = mine(await claimDueSchedules(db, now, 60_000));
    if (!claimed) throw new Error("expected a claim");
    expect(await completeClaim(db, claimed, now)).toBe(true);

    const after = await getSchedule(db, created.id);
    expect(after).toMatchObject({ status: "done", nextFireAt: null });
    expect(mine(await claimDueSchedules(db, new Date("2026-10-22T00:00:00Z"), 60_000))).toEqual([]);
    expect((await listSchedules(db)).some((row) => row.id === created.id)).toBe(false);
  });

  it("will not resume a one-time row whose time passed", async () => {
    const db = await sql();
    const { cron: _cron, ...once } = input;
    const created = await createSchedule(
      db,
      { ...once, title: "Late", runAt: new Date("2026-10-20T10:00:00Z") },
      T0,
    );
    await pauseSchedule(db, created.id);
    await expect(resumeSchedule(db, created.id, new Date("2026-10-20T11:00:00Z"))).rejects.toThrow(
      "That time has passed.",
    );
  });

  it("claims a due row once, even with two concurrent claims", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Concurrent" }, T0);
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
    const created = await createSchedule(db, { ...input, title: "Lease" }, T0);
    const due = new Date("2026-10-20T09:00:00Z");
    const mine = (rows: Schedule[]) => rows.filter((row) => row.id === created.id);
    expect(mine(await claimDueSchedules(db, due, 60_000))).toHaveLength(1);
    expect(mine(await claimDueSchedules(db, new Date("2026-10-20T09:00:30Z"), 60_000))).toEqual([]);
    expect(
      mine(await claimDueSchedules(db, new Date("2026-10-20T09:02:00Z"), 60_000)),
    ).toHaveLength(1);
  });

  it("completeClaim records the fire, clears the lease, and skips missed windows", async () => {
    const db = await sql();
    const created = await createSchedule(
      db,
      { ...input, title: "Complete", cron: "0 * * * *" },
      T0,
    );
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
    const created = await createSchedule(db, { ...input, title: "Pause mid-fire" }, T0);
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
    const created = await createSchedule(db, { ...input, title: "Runs" }, T0);
    const run = await recordRun(db, { scheduleId: created.id, firedAt: T0, sessionId: "s1" });
    expect(run.outcome).toBe("started");
    await finishRun(db, run.id, "all_clear");
    const runs = (await runsSince(db, new Date("2026-10-20T00:00:00Z"))).filter(
      (r) => r.scheduleId === created.id,
    );
    expect(runs.map((r) => [r.sessionId, r.outcome])).toEqual([["s1", "all_clear"]]);
  });

  it("ends a run by session once and links the job", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "By session" }, T0);
    const run = await recordRun(db, { scheduleId: created.id, firedAt: T0, sessionId: "s-by" });
    const [job] = await db<{ id: string }[]>`
      insert into jobs (request_key, kind, title, brief, worker)
      values ('k-by', 'code-change', 't', '{}', 't3') returning id
    `;
    const jobId = Number(job?.id);
    await finishRunForSession(db, "s-by", "started", jobId);
    await finishRunForSession(db, "s-by", "all_clear", jobId);
    await finishRunForSession(db, "s-by", "failed", jobId);
    const [after] = (await runsSince(db, new Date("2026-10-20T00:00:00Z"))).filter(
      (r) => r.id === run.id,
    );
    expect([after?.outcome, after?.jobId]).toEqual(["all_clear", jobId]);
  });

  it("reserves one run per fire, so a repeated dispatch does not send twice", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Identity" }, T0);
    const due = new Date("2026-10-20T09:00:00Z");
    const first = await reserveRun(db, { scheduleId: created.id, dueAt: due, firedAt: due });
    expect(first?.scheduleId).toBe(created.id);
    // A second dispatcher after a crash and a lease expiry sees the same fire.
    expect(
      await reserveRun(db, {
        scheduleId: created.id,
        dueAt: due,
        firedAt: new Date("2026-10-20T09:06:00Z"),
      }),
    ).toBeUndefined();
    // The next fire is a new identity.
    const later = new Date("2026-10-21T09:00:00Z");
    expect(
      await reserveRun(db, { scheduleId: created.id, dueAt: later, firedAt: later }),
    ).toBeDefined();
  });

  it("recovers a crash after the send: the lease expires, the fire is skipped, the claim completes", async () => {
    const db = await sql();
    const created = await createSchedule(db, { ...input, title: "Crash", cron: "0 * * * *" }, T0);
    const t1 = new Date("2026-10-20T09:00:30Z");
    const mine = (rows: Schedule[]) => rows.filter((r) => r.id === created.id);
    const [claim1] = mine(await claimDueSchedules(db, t1, 60_000));
    if (!claim1?.nextFireAt) throw new Error("expected a claim");
    const run = await reserveRun(db, {
      scheduleId: created.id,
      dueAt: claim1.nextFireAt,
      firedAt: t1,
    });
    if (!run) throw new Error("expected a run");
    await attachSession(db, run.id, "s-crash");
    // Dispatcher 1 dies here, before completeClaim.
    const t2 = new Date("2026-10-20T09:03:00Z");
    const [claim2] = mine(await claimDueSchedules(db, t2, 60_000));
    if (!claim2?.nextFireAt) throw new Error("expected a second claim after the lease");
    expect(
      await reserveRun(db, { scheduleId: created.id, dueAt: claim2.nextFireAt, firedAt: t2 }),
    ).toBeUndefined();
    expect(await completeClaim(db, claim2, t2)).toBe(true);
    const after = await getSchedule(db, created.id);
    expect(after?.nextFireAt?.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    const runs = (await runsSince(db, T0)).filter((r) => r.scheduleId === created.id);
    expect(runs).toHaveLength(1);
  });

  it("completeClaim does nothing for a dispatcher that lost its lease", async () => {
    const db = await sql();
    const created = await createSchedule(
      db,
      { ...input, title: "Lost lease", cron: "0 * * * *" },
      T0,
    );
    const mine = (rows: Schedule[]) => rows.filter((r) => r.id === created.id);
    const [old] = mine(await claimDueSchedules(db, new Date("2026-10-20T09:00:30Z"), 60_000));
    const [fresh] = mine(await claimDueSchedules(db, new Date("2026-10-20T09:05:00Z"), 60_000));
    if (!old || !fresh) throw new Error("expected two claims");
    expect(await completeClaim(db, old, new Date("2026-10-20T09:05:10Z"))).toBe(false);
    expect((await getSchedule(db, created.id))?.leaseUntil).not.toBeNull();
    expect(await completeClaim(db, fresh, new Date("2026-10-20T09:05:10Z"))).toBe(true);
  });

  it("binds pre-approval to the run of this session, one job only", async () => {
    const db = await sql();
    const a = await createSchedule(db, { ...input, title: "Bind A" }, T0);
    const b = await createSchedule(db, { ...input, title: "Bind B" }, T0);
    const due = new Date("2026-10-20T09:00:00Z");
    const run = await reserveRun(db, { scheduleId: a.id, dueAt: due, firedAt: due });
    if (!run) throw new Error("expected a run");
    const job1 = await newJob("bind-1");
    const job2 = await newJob("bind-2");
    // Before the session is attached, nothing matches.
    expect(await claimRunForJob(db, "s-bind", a.id, job1)).toBe(false);
    await attachSession(db, run.id, "s-bind");
    // Another session, or another schedule, cannot use this run.
    expect(await claimRunForJob(db, "s-other", a.id, job1)).toBe(false);
    expect(await claimRunForJob(db, "s-bind", b.id, job1)).toBe(false);
    // The first job claims it, a replay of the same job passes, a second job does not.
    expect(await claimRunForJob(db, "s-bind", a.id, job1)).toBe(true);
    expect(await claimRunForJob(db, "s-bind", a.id, job1)).toBe(true);
    expect(await claimRunForJob(db, "s-bind", a.id, job2)).toBe(false);
  });

  it("waits for the dispatcher to attach the session, then claims", async () => {
    const db = await sql();
    const a = await createSchedule(db, { ...input, title: "Late attach" }, T0);
    // fired_at is now, so the run counts as recently reserved.
    const run = await reserveRun(db, {
      scheduleId: a.id,
      dueAt: new Date("2026-10-21T09:00:00Z"),
      firedAt: new Date(),
    });
    if (!run) throw new Error("expected a run");
    const job = await newJob("late-attach");

    const claim = claimRunWhenAttached(db, "s-late", a.id, job, { attempts: 20, delayMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await attachSession(db, run.id, "s-late");

    expect(await claim).toBe(true);
  });

  it("does not wait when no run is waiting to be attached", async () => {
    const db = await sql();
    const a = await createSchedule(db, { ...input, title: "No run" }, T0);
    const job = await newJob("no-run");
    const started = Date.now();

    expect(await claimRunWhenAttached(db, "s-none", a.id, job, { attempts: 20, delayMs: 50 })).toBe(
      false,
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("lets only one of two concurrent jobs claim the run", async () => {
    const db = await sql();
    const a = await createSchedule(db, { ...input, title: "Race" }, T0);
    const due = new Date("2026-10-20T09:00:00Z");
    const run = await reserveRun(db, { scheduleId: a.id, dueAt: due, firedAt: due });
    if (!run) throw new Error("expected a run");
    await attachSession(db, run.id, "s-race");
    const jobs = [await newJob("race-1"), await newJob("race-2")];
    const results = await Promise.all(jobs.map((id) => claimRunForJob(db, "s-race", a.id, id)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("parseScheduleRef", () => {
  it("reads S-3 and 3", () => {
    expect(parseScheduleRef("S-3")).toBe(3);
    expect(parseScheduleRef(" 3 ")).toBe(3);
    expect(parseScheduleRef("J-3")).toBeUndefined();
  });
});
