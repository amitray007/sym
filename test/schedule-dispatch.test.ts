import { afterEach, describe, expect, it, vi } from "vitest";
import { threadUserOf } from "../lib/requester.ts";
import {
  type DispatchDeps,
  deliveryKey,
  dispatchDue,
  ONE_TIME_RETRY_MS,
} from "../lib/schedules/dispatch.ts";
import {
  attachSession,
  createSchedule,
  finishRunWithoutJob,
  getSchedule,
  reserveRun,
  runCreatorOf,
  runsSince,
  type Schedule,
} from "../lib/schedules/rows.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 085: the dispatcher delivers each fire once. A one-time run that never reached Slack
// is delivered again, with the same key, before its row is done. A recurring fire that a crashed
// dispatcher left behind is skipped and fails.

const T0 = new Date("2026-11-03T08:00:00Z");
const LEASE_MS = 60_000;
const base = {
  title: "Reminder",
  instruction: "Remind me to send the report.",
  builder: "ask" as const,
  channel: "C1",
  owner: "UCREATOR",
};

const APP = {
  principalId: "eve:app",
  authenticator: "app",
  principalType: "runtime",
  attributes: {},
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasDatabase)("dispatchDue", () => {
  const ledger = useLedger();
  let counter = 0;
  afterEach(() => vi.unstubAllEnvs());

  const deps = (now: Date, send: DispatchDeps["send"], mayRun = () => true): DispatchDeps => ({
    sql: ledger.sql(),
    now,
    leaseMs: LEASE_MS,
    mayRun,
    send,
  });
  const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

  async function oneTime(): Promise<Schedule> {
    counter += 1;
    const runAt = at(T0, counter * 3_600_000);
    return createSchedule(ledger.sql(), { ...base, title: `Once ${counter}`, runAt }, T0);
  }
  const runsOf = async (id: number) =>
    (await runsSince(ledger.sql(), new Date(0))).filter((run) => run.scheduleId === id);

  it("delivers a one-time run once, with the run's key, and the row is done", async () => {
    const schedule = await oneTime();
    const due = schedule.nextFireAt as Date;
    const send = vi.fn<DispatchDeps["send"]>(async () => "s-once");
    await dispatchDue(deps(at(due, 1_000), send));
    const [run] = await runsOf(schedule.id);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[2]).toBe(deliveryKey(run?.id ?? 0));
    expect(run?.sessionId).toBe("s-once");
    expect((await getSchedule(ledger.sql(), schedule.id))?.status).toBe("done");
  });

  it("delivers a one-time run that a crashed dispatcher reserved but never sent", async () => {
    const schedule = await oneTime();
    const due = schedule.nextFireAt as Date;
    // The first dispatcher claims the row, reserves the run, and dies before its send.
    const crashed = vi.fn(async (): Promise<string> => {
      throw new Error("process died");
    });
    await dispatchDue(deps(at(due, 1_000), crashed));
    expect((await getSchedule(ledger.sql(), schedule.id))?.status).toBe("active");
    const [reserved] = await runsOf(schedule.id);
    expect(reserved).toMatchObject({ sessionId: null, outcome: "started" });

    // After the lease runs out, the next dispatcher sends it again with the same key.
    const send = vi.fn<DispatchDeps["send"]>(async () => "s-retry");
    await dispatchDue(deps(at(due, 2 * LEASE_MS), send));
    expect(send.mock.calls[0]?.[2]).toBe(deliveryKey(reserved?.id ?? 0));
    const runs = await runsOf(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toBe("s-retry");
    expect((await getSchedule(ledger.sql(), schedule.id))?.status).toBe("done");
  });

  it("gives a one-time delivery up after the retry window and fails the run", async () => {
    const schedule = await oneTime();
    const due = schedule.nextFireAt as Date;
    const failing = async (): Promise<string> => {
      throw new Error("slack down");
    };
    await dispatchDue(deps(at(due, 1_000), failing));
    await dispatchDue(deps(at(due, ONE_TIME_RETRY_MS + 2 * LEASE_MS), failing));
    const [run] = await runsOf(schedule.id);
    expect(run?.outcome).toBe("failed");
    expect((await getSchedule(ledger.sql(), schedule.id))?.status).toBe("done");
  });

  it("skips a recurring fire left undelivered and ends its run as failed", async () => {
    const schedule = await createSchedule(
      ledger.sql(),
      { ...base, title: "Daily", cron: "0 9 * * *" },
      T0,
    );
    const due = schedule.nextFireAt as Date;
    // A dispatcher reserved the run and died before its send.
    await reserveRun(ledger.sql(), { scheduleId: schedule.id, dueAt: due, firedAt: due });
    const send = vi.fn(async () => "s-never");
    await dispatchDue(deps(at(due, 2 * LEASE_MS), send));
    expect(send).not.toHaveBeenCalled();
    const [run] = await runsOf(schedule.id);
    expect(run?.outcome).toBe("failed");
    expect((await getSchedule(ledger.sql(), schedule.id))?.nextFireAt?.toISOString()).toBe(
      at(due, 24 * 3_600_000).toISOString(),
    );
  });

  it("fails the run of a creator who left the allow-list, without a send", async () => {
    const schedule = await oneTime();
    const send = vi.fn(async () => "s-no");
    await dispatchDue(deps(at(schedule.nextFireAt as Date, 1_000), send, () => false));
    expect(send).not.toHaveBeenCalled();
    expect((await runsOf(schedule.id))[0]?.outcome).toBe("failed");
  });

  it("applies a turn that settled before the dispatcher attached its session", async () => {
    const sql = ledger.sql();
    const quiet = await oneTime();
    const loud = await oneTime();
    const settle = (sessionId: string, posted: boolean) =>
      finishRunWithoutJob(sql, sessionId, posted ? "needs_attention" : "all_clear");
    // A fast turn ends before attachSession runs.
    const send = (outcome: boolean) => async (schedule: Schedule) => {
      const sessionId = `s-fast-${schedule.id}`;
      await settle(sessionId, outcome);
      return sessionId;
    };
    await dispatchDue(deps(at(quiet.nextFireAt as Date, 1_000), send(false)));
    await dispatchDue(deps(at(loud.nextFireAt as Date, 1_000), send(true)));
    expect((await runsOf(quiet.id))[0]?.outcome).toBe("all_clear");
    expect((await runsOf(loud.id))[0]?.outcome).toBe("needs_attention");
  });

  it("finds the creator when the attach lands between its two reads", async () => {
    const sql = ledger.sql();
    const schedule = await oneTime();
    const due = schedule.nextFireAt as Date;
    const run = await reserveRun(sql, { scheduleId: schedule.id, dueAt: due, firedAt: due });
    if (!run) throw new Error("expected a run");
    // The run is not recent, so the lookup does not wait. The attach lands right before the
    // query for pending runs.
    const racing = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("").includes("session_id is null")) {
        return attachSession(sql, run.id, "s-race").then(() => sql(strings, ...(values as [])));
      }
      return sql(strings, ...(values as []));
    }) as unknown as typeof sql;
    expect(await runCreatorOf(racing, "s-race", { attempts: 1 })).toBe("UCREATOR");
  });

  it("binds the creator for a retried delivery whose turn starts before the attach", async () => {
    const sql = ledger.sql();
    vi.stubEnv("SYM_SLACK_USERS", "UCREATOR");
    const now = Date.now();
    const schedule = await createSchedule(
      sql,
      { ...base, title: "Retried", runAt: new Date(now - 11 * 60_000) },
      new Date(now - 20 * 60_000),
    );
    // The first delivery fails ten minutes ago; the run's fire time is now old.
    const down = async (): Promise<string> => {
      throw new Error("slack down");
    };
    await dispatchDue(deps(new Date(now - 10 * 60_000), down));
    let lookup: Promise<string | null> | undefined;
    // The retry's turn starts and records its thread before the dispatcher attaches it.
    const send = async (fired: Schedule) => {
      if (fired.id !== schedule.id) return `s-other-${fired.id}`;
      const session = { id: "s-retried", auth: { current: APP } };
      lookup = threadUserOf(session, null, () => ({ sql }));
      await pause(200);
      return session.id;
    };
    await dispatchDue(deps(new Date(now), send));
    expect(await lookup).toBe("UCREATOR");
    expect((await runsOf(schedule.id))[0]?.sessionId).toBe("s-retried");
  });

  it("applies a settlement that commits while the attach waits on the run", async () => {
    const sql = ledger.sql();
    const schedule = await oneTime();
    const due = schedule.nextFireAt as Date;
    const run = await reserveRun(sql, { scheduleId: schedule.id, dueAt: due, firedAt: due });
    if (!run) throw new Error("expected a run");
    // A third connection holds the run's row, so the attach starts its statement and waits.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = sql.begin(async (tx) => {
      await tx`select id from schedule_runs where id = ${run.id} for update`;
      locked();
      await held;
    });
    await isLocked;
    const attaching = attachSession(sql, run.id, "s-overlap");
    await pause(200);
    // The turn settles while the attach waits. Without the session lock, the settlement sees no
    // attached run, and the attach misses the settlement.
    const settling = finishRunWithoutJob(sql, "s-overlap", "needs_attention");
    await pause(200);
    release();
    await Promise.all([blocker, attaching, settling]);
    const [after] = await runsOf(schedule.id);
    expect(after).toMatchObject({ sessionId: "s-overlap", outcome: "needs_attention" });
  });
});
