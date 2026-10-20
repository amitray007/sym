import { describe, expect, it } from "vitest";
import type { Brief } from "../lib/jobs/brief.ts";
import { reconcileWorkerPass, WORKER_NOT_CONFIGURED } from "../lib/jobs/reconcile.ts";
import { type JobDeps, launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import { getJob } from "../lib/ledger/jobs.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

// Reconcile tells a missing worker configuration apart from an outage (decision 036).

const brief: Brief = {
  project: "test-repo",
  title: "Config check",
  goal: "Nothing.",
  constraints: [],
  doneWhen: ["Nothing."],
  baseRef: "main",
  openPullRequest: false,
  estimatedMinutes: 5,
};

describe.skipIf(!hasDatabase)("reconcileWorkerPass", () => {
  const ledger = useLedger();
  let n = 0;

  // An orphaned running job: launched, with its watcher lease run out.
  async function orphan() {
    const sql = ledger.sql();
    await sql`update jobs set status = 'cancelled', finished_at = now()
      where status not in ('done', 'failed', 'cancelled')`;
    const worker = new FakeWorker({ script: [{ status: "running", items: ["Working"] }] });
    const deps: JobDeps = { sql, worker, allowedProjects: TEST_PROJECTS };
    const job = await startJob(sql, {
      requestKey: `config-${++n}`,
      sessionId: `config-session-${n}`,
      brief,
    });
    await launchOrAdopt(deps, job.id, "http://127.0.0.1:1/hook");
    await sql`update jobs set watch_until = now() - interval '1 minute' where id = ${job.id}`;
    return { sql, job };
  }

  it("skips the worker pass with one warning when nothing is configured", async () => {
    const { sql, job } = await orphan();
    const warnings: string[] = [];

    const result = await reconcileWorkerPass({ sql }, undefined, (m) => warnings.push(m));

    expect(result).toBe("not_configured");
    expect(warnings).toEqual([WORKER_NOT_CONFIGURED]);
    expect((await getJob(sql, job.id))?.status).toBe("running");
    const posts = await sql`select 1 from outbox where job_id = ${job.id}
      and idempotency_key like '%offline%'`;
    expect(posts).toHaveLength(0);
  });

  it("treats a sign-in that vanished before connecting as not configured", async () => {
    const { sql, job } = await orphan();
    const warnings: string[] = [];
    const gone = Object.assign(new Error("no sign-in"), { name: "WorkerNotConfiguredError" });

    const result = await reconcileWorkerPass(
      { sql },
      async () => {
        throw gone;
      },
      (m) => warnings.push(m),
    );

    expect(result).toBe("not_configured");
    expect(warnings).toHaveLength(1);
    expect((await getJob(sql, job.id))?.status).toBe("running");
  });

  it("still marks jobs offline when the connection fails", async () => {
    const { sql, job } = await orphan();
    const warnings: string[] = [];

    const result = await reconcileWorkerPass(
      { sql },
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
      (m) => warnings.push(m),
    );

    expect(result).toMatchObject({ offline: 1 });
    expect(warnings).toEqual([]);
    expect((await getJob(sql, job.id))?.status).toBe("worker_offline");
  });
});
