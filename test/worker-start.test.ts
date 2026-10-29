import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import { Brief } from "../lib/jobs/brief.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import type { JobDeps } from "../lib/jobs/run.ts";
import { approvePlaybook, propose } from "../lib/learning/rows.ts";
import { linkPlaybook, recordOutcome, setStartMode } from "../lib/learning/trust.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { approveSchedule, createSchedule, recordRun } from "../lib/schedules/rows.ts";
import { handleTypedProposal } from "../lib/slack/job-actions.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  deps: undefined as JobDeps | undefined,
  sleeps: [] as number[],
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
  createWebhook: () => Object.assign(new Promise(() => {}), { url: "http://127.0.0.1/cb" }),
  FatalError: Error,
  sleep: async (ms: number) => {
    runtime.sleeps.push(ms);
    if (runtime.sleeps.length > 12) throw new Error("Proposal exceeded its workflow event budget");
  },
}));

import workerJob from "../agent/tools/worker_job.ts";

describe.skipIf(!hasDatabase)("worker_job Start wait", () => {
  const ledger = useLedger();
  afterEach(() => vi.unstubAllEnvs());
  async function run(key: string, playbook?: string, scheduled = false) {
    runtime.sql = ledger.sql();
    runtime.sleeps.length = 0;
    runtime.deps = { sql: runtime.sql, worker: new FakeWorker(), allowedProjects: TEST_PROJECTS };
    vi.stubEnv("SYM_CODE_CHANNELS", "off");
    const brief = Brief.parse({
      project: "test-repo",
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
    let schedule: string | undefined;
    if (scheduled) {
      const row = await createSchedule(runtime.sql, {
        cron: "0 9 * * *",
        title: key,
        brief,
        channel: "C1",
        owner: "U1",
      });
      await approveSchedule(runtime.sql, row.id, "U1", new Date());
      await recordRun(runtime.sql, { scheduleId: row.id, firedAt: new Date(), sessionId: key });
      context.session.auth.initiator = {
        principalId: "eve:app",
        authenticator: "app",
        principalType: "runtime",
      } as typeof context.session.auth.initiator;
      schedule = `S-${row.id}`;
    }
    // biome-ignore lint/suspicious/noExplicitAny: invoke the registered workflow body without its runtime compiler
    return (workerJob as any).task(
      { ...brief, ...(schedule ? { schedule } : {}) },
      context,
    ) as AsyncGenerator<{ status: string }, { status: string }>;
  }
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
    await setStartMode(sql, approved.id, "auto", "U1");
    const task = await run("trusted-chat", approved.name);
    expect((await task.next()).value?.status).toContain("Waiting for Start");
    expect(
      (
        await sql`select p.status from job_proposals p join jobs j on j.id = p.job_id where j.request_key = 'trusted-chat:trusted-chat'`
      )[0]?.status,
    ).toBe("pending");
    await task.return({ status: "test-ended" });
  });
  it("keeps an approved scheduled run automatic", async () => {
    const task = await run("approved-schedule", undefined, true);
    expect((await task.next()).value?.status).toContain("Starting scheduled run");
    expect((await task.next()).value?.status).toContain("Launching");
    expect((await task.next()).value?.status).toContain("thread started");
    expect(
      await ledger.sql()`select p.id from job_proposals p join jobs j on j.id = p.job_id where j.request_key = 'approved-schedule:approved-schedule'`,
    ).toHaveLength(0);
    expect(runtime.sleeps).toEqual([]);
    await task.return({ status: "test-ended" });
  });
});
