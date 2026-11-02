import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import { Brief } from "../lib/jobs/brief.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import type { JobDeps } from "../lib/jobs/run.ts";
import { approvePlaybook, propose } from "../lib/learning/rows.ts";
import { linkPlaybook, recordOutcome } from "../lib/learning/trust.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { type BuilderMode, createSchedule, recordRun } from "../lib/schedules/rows.ts";
import { handleProposal, handleTypedProposal } from "../lib/slack/job-actions.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  deps: undefined as JobDeps | undefined,
  sleeps: [] as number[],
  holdSleep: false,
  wakes: new Map<string, () => void>(),
}));
vi.mock("eve/workflow/api", () => ({
  resumeHook: async (token: string) => runtime.wakes.get(token)?.(),
}));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  ledgerDeps: () => runtime.deps,
  allowedFromEnv: () => TEST_PROJECTS,
  pack: () => undefined,
  withJobDeps: (fn: (deps: JobDeps) => unknown) => {
    if (!runtime.deps) throw new Error("Missing test dependencies");
    return fn(runtime.deps);
  },
}));
vi.mock("eve/workflow", () => ({
  createHook: ({ token }: { token: string }) => {
    const hook = new Promise<void>((resolve) => runtime.wakes.set(token, resolve));
    return Object.assign(hook, {
      getConflict: async () => null,
      dispose: () => runtime.wakes.delete(token),
    });
  },
  createWebhook: () => Object.assign(new Promise(() => {}), { url: "http://127.0.0.1/cb" }),
  FatalError: Error,
  sleep: async (ms: number) => {
    runtime.sleeps.push(ms);
    if (runtime.holdSleep) await new Promise(() => {});
    if (runtime.sleeps.length > 12) throw new Error("Proposal exceeded its workflow event budget");
  },
}));

import workerJob from "../agent/tools/worker_job.ts";

describe.skipIf(!hasDatabase)("worker_job Start wait", () => {
  const ledger = useLedger();
  afterEach(() => vi.unstubAllEnvs());
  // `schedule` makes the session a run of a schedule with that builder mode. The dispatcher
  // starts such a session as the app principal, unless `byPerson` sends the same message.
  async function run(
    key: string,
    playbook?: string,
    schedule?: { builder: BuilderMode; byPerson?: boolean; project?: string },
  ) {
    runtime.sql = ledger.sql();
    runtime.sleeps.length = 0;
    runtime.holdSleep = false;
    runtime.wakes.clear();
    runtime.deps = { sql: runtime.sql, worker: new FakeWorker(), allowedProjects: TEST_PROJECTS };
    vi.stubEnv("SYM_CODE_CHANNELS", "off");
    vi.stubEnv("SYM_SLACK_USERS", "U1");
    const brief = Brief.parse({
      project: schedule?.project ?? "test-repo",
      title: key,
      goal: "add retries",
      doneWhen: ["Test"],
      ...(playbook ? { playbook } : {}),
    });
    await recordSessionThread(runtime.sql, {
      sessionId: key,
      channelId: "C1",
      threadTs: key,
      teamId: "T1",
      userId: "U1",
    });
    const context = {
      session: {
        id: key,
        auth: {
          initiator: { principalId: "slack:T1:U1" },
          current: { principalId: "slack:T1:U1" },
        },
      },
      callId: key,
      abortSignal: new AbortController().signal,
    };
    let ref: string | undefined;
    if (schedule) {
      const row = await createSchedule(
        runtime.sql,
        {
          cron: "0 9 * * *",
          title: key,
          instruction: "Add retries to test-repo.",
          builder: schedule.builder,
          channel: "C1",
          owner: "U1",
        },
        new Date(),
      );
      await recordRun(runtime.sql, { scheduleId: row.id, firedAt: new Date(), sessionId: key });
      if (!schedule.byPerson) {
        context.session.auth.initiator = {
          principalId: "eve:app",
          authenticator: "app",
          principalType: "runtime",
        } as typeof context.session.auth.initiator;
      }
      ref = `S-${row.id}`;
    }
    // biome-ignore lint/suspicious/noExplicitAny: invoke the registered workflow body without its runtime compiler
    return (workerJob as any).task(
      { ...brief, ...(ref ? { schedule: ref } : {}) },
      context,
    ) as AsyncGenerator<{ status: string }, { status: string }>;
  }
  it.each(["click", "typed"])(
    "wakes Start promptly after an authorized %s",
    async (kind) => {
      const task = await run(`prompt-${kind}`);
      await task.next();
      runtime.holdSleep = true;
      const launching = task.next();
      await vi.waitFor(() => expect(runtime.sleeps).toEqual([300_000]));
      const sql = ledger.sql();
      const deps = runtime.deps;
      if (!deps) throw new Error("Missing test dependencies");
      const [proposal] = await sql`select id from job_proposals where status = 'pending'`;
      const input = {
        id: String(proposal?.id),
        by: "U1",
        channel: "C1",
        threadTs: `prompt-${kind}`,
        start: true,
      };
      expect(await handleProposal(deps, { ...input, by: "U2" }, (by) => by === "U1")).toMatchObject(
        { kind: "refused" },
      );
      expect((deps.worker as FakeWorker).launches).toBe(0);
      if (kind === "click") await handleProposal(deps, input, (by) => by === "U1");
      else await handleTypedProposal(deps, { ...input, text: "start" }, (by) => by === "U1");
      await expect(launching).resolves.toMatchObject({
        done: false,
        value: { status: expect.stringContaining("Launching") },
      });
      await task.next();
      expect((deps.worker as FakeWorker).launches).toBe(1);
      expect(runtime.sleeps).toEqual([300_000]);
      await task.return({ status: "test-ended" });
    },
    2000,
  );
  it("bounds an idle proposal to twelve five-minute waits, leaving late Start to reconcile", async () => {
    const task = await run("bounded-start");
    expect((await task.next()).value?.status).toContain("Waiting for Start");
    await expect(task.next()).resolves.toMatchObject({
      done: true,
      value: { status: "awaiting_start" },
    });
    expect(runtime.sleeps).toHaveLength(12);
    expect(runtime.sleeps.every((ms) => ms >= 300_000)).toBe(true);
    expect(
      (
        await ledger.sql()`select status from jobs where request_key = 'bounded-start:bounded-start'`
      )[0]?.status,
    ).toBe("launching");
    const sql = ledger.sql();
    vi.stubEnv("SYM_SLACK_USERS", "U1");
    await handleTypedProposal(
      runtime.deps as JobDeps,
      { text: "start", by: "U1", channel: "C1", threadTs: "bounded-start" },
      (by) => by === "U1",
    );
    await sql`update job_proposals set created_at = now() - interval '2 minutes'`;
    await reconcileJobs(runtime.deps as JobDeps);
    expect(
      (await sql`select status from jobs where request_key = 'bounded-start:bounded-start'`)[0]
        ?.status,
    ).toBe("running");
  });
  it("shows Start for an interactive trusted playbook", async () => {
    const sql = ledger.sql();
    const proposed = await propose(sql, {
      name: "interactive-trust",
      kind: "playbook",
      body: "Steps",
      source: "owner",
    });
    const approved = await approvePlaybook(sql, proposed.id, "U1", new Date());
    if (!approved) throw new Error("missing playbook");
    const old = await createJob(sql, {
      requestKey: "clean",
      title: "Clean",
      kind: "code-change",
      worker: "fake",
      brief: { project: "test-repo" },
    });
    await linkPlaybook(sql, old.id, approved.name);
    await sql`update jobs set status = 'done', finished_at = now() where id = ${old.id}`;
    await recordOutcome(sql, { id: old.id, kind: "code-change", status: "done" }, true, undefined);
    await sql`update playbooks set start_mode = 'auto' where id = ${approved.id}`;
    const task = await run("trusted-chat", approved.name);
    expect((await task.next()).value?.status).toContain("Waiting for Start");
    expect(
      (
        await sql`select p.status from job_proposals p join jobs j on j.id = p.job_id where j.request_key = 'trusted-chat:trusted-chat'`
      )[0]?.status,
    ).toBe("pending");
    await task.return({ status: "test-ended" });
  });
  const launches = () => (runtime.deps?.worker as FakeWorker | undefined)?.launches;
  const proposals = (key: string) =>
    ledger.sql()`select p.id from job_proposals p join jobs j on j.id = p.job_id where j.request_key = ${`${key}:${key}`}`;

  it("starts a run of an auto-start schedule without a click", async () => {
    const task = await run("auto-schedule", undefined, { builder: "auto" });
    expect((await task.next()).value?.status).toContain("Starting scheduled run");
    expect((await task.next()).value?.status).toContain("Launching");
    expect((await task.next()).value?.status).toContain("thread started");
    expect(await proposals("auto-schedule")).toHaveLength(0);
    expect(runtime.sleeps).toEqual([]);
    await task.return({ status: "test-ended" });
  });

  it("shows Start for a run of a schedule that asks", async () => {
    const task = await run("ask-schedule", undefined, { builder: "ask" });
    expect((await task.next()).value?.status).toContain("Waiting for Start");
    expect(await proposals("ask-schedule")).toHaveLength(1);
    expect(launches()).toBe(0);
    await task.return({ status: "test-ended" });
  });

  it("shows Start when a person sends an auto-start schedule's reference", async () => {
    const task = await run("person-schedule", undefined, { builder: "auto", byPerson: true });
    expect((await task.next()).value?.status).toContain("Waiting for Start");
    expect(await proposals("person-schedule")).toHaveLength(1);
    await task.return({ status: "test-ended" });
  });

  it("refuses a scheduled run on a project outside the list, and the run fails", async () => {
    const task = await run("outside-schedule", undefined, {
      builder: "auto",
      project: "other-repo",
    });
    await expect(task.next()).resolves.toMatchObject({
      done: true,
      value: { status: "not_started" },
    });
    expect(
      await ledger.sql()`select id from jobs where request_key = 'outside-schedule:outside-schedule'`,
    ).toHaveLength(0);
    const [runRow] =
      await ledger.sql()`select outcome from schedule_runs where session_id = 'outside-schedule'`;
    expect(runRow?.outcome).toBe("failed");
    expect(launches()).toBe(0);
  });

  it("refuses Builder work when the creator left the allow-list after the dispatch", async () => {
    const task = await run("revoked-schedule", undefined, { builder: "auto" });
    // The dispatcher sent the run while U1 was allowed. Then the owner removed U1.
    vi.stubEnv("SYM_SLACK_USERS", "UOTHER");
    await expect(task.next()).resolves.toMatchObject({
      done: true,
      value: { status: "not_started", reason: expect.stringContaining("allow-list") },
    });
    expect(
      await ledger.sql()`select id from jobs where request_key = 'revoked-schedule:revoked-schedule'`,
    ).toHaveLength(0);
    const [runRow] =
      await ledger.sql()`select outcome from schedule_runs where session_id = 'revoked-schedule'`;
    expect(runRow?.outcome).toBe("failed");
    expect(launches()).toBe(0);
  });
});
