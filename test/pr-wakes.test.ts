import { describe, expect, it } from "vitest";
import {
  checkPrWakes,
  ensurePrWatched,
  reportWakes,
  wakeOf,
  wakeText,
  watchedPrJobs,
} from "../lib/jobs/pr-wakes.ts";
import { createJob, getJob, jobRef, updateJob } from "../lib/ledger/jobs.ts";
import { migrate } from "../lib/ledger/migrate.ts";
import { workerMigration } from "../lib/workers/migration.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const PR = "https://github.com/example/app/pull/12";

describe("wakeOf", () => {
  it("reads a wake notification", () => {
    expect(
      wakeOf({ position: 3, type: "notification", text: "#12: checks failed, new comments" }),
    ).toEqual({ number: 12, summary: "checks failed, new comments" });
  });

  it("ignores messages and other notifications", () => {
    expect(wakeOf({ position: 0, type: "assistant_message", text: "#12: checks failed" })).toBe(
      undefined,
    );
    expect(wakeOf({ position: 1, type: "notification", text: "Subagent finished" })).toBe(
      undefined,
    );
  });
});

describe("wakeText", () => {
  const job = { id: 7, prUrl: PR };

  it("links the PR and says the worker acts on a failure", () => {
    expect(wakeText(job, { number: 12, summary: "checks failed" })).toBe(
      `J-7: <${PR}|PR #12>: checks failed. The worker is looking into it.`,
    );
  });

  it("reports passing checks without a promise of work", () => {
    expect(wakeText(job, { number: 12, summary: "checks passed" })).toBe(
      `J-7: <${PR}|PR #12>: checks passed.`,
    );
  });

  it("tells the owner to check a PR the worker stopped watching", () => {
    expect(wakeText(job, { number: 12, summary: "stopped watching, could not read it" })).toMatch(
      /no longer watched .* Check it yourself\.$/,
    );
  });
});

describe.skipIf(!hasDatabase)("pull request wakes", () => {
  const ledger = useLedger();
  let n = 0;

  async function setup(options: { pr?: boolean } = {}) {
    const sql = ledger.sql();
    // The coordinator registers this migration in lib/ledger/migrations.ts. Applying it twice is
    // a no-op.
    await migrate(sql, [workerMigration]);
    const worker = new FakeWorker();
    const thread = await worker.launch({
      projectId: "project-1",
      title: "[J-0] x",
      message: "m",
      baseRef: "main",
    });
    let job = await createJob(sql, {
      requestKey: `pr-wakes-${++n}`,
      kind: "code-change",
      title: "Retry",
      brief: {},
      worker: "fake",
      slackChannel: "C1",
      slackThreadTs: "1690000000.000100",
    });
    job = await updateJob(sql, job.id, {
      workerThreadId: thread.id,
      status: "done",
      ...(options.pr === false ? {} : { prUrl: PR }),
    });
    const posts = async () =>
      (
        await sql<{ key: string; payload: { text: string; channel: string; thread_ts: string } }[]>`
          select idempotency_key as key, payload from outbox
          where job_id = ${job.id} and idempotency_key like ${`${jobRef(job.id)}:prwake:%`}
          order by id`
      ).map((row) => ({ key: row.key, ...row.payload }));
    return { sql, worker, thread, job, deps: { sql, worker }, posts };
  }

  it("asks the worker to watch the PR once", async () => {
    const s = await setup();

    expect(await ensurePrWatched(s.deps, s.job)).toBe("watching");
    expect(await ensurePrWatched(s.deps, s.job)).toBe("already");

    expect(s.worker.watches).toEqual([
      { threadId: s.thread.id, prUrl: PR, requestId: `${jobRef(s.job.id)}:watch` },
    ]);
  });

  it("skips a job without a PR or without a worker that can watch", async () => {
    const noPr = await setup({ pr: false });
    expect(await ensurePrWatched(noPr.deps, noPr.job)).toBe("skipped");

    const s = await setup();
    const basic = { ...s.deps, worker: { ...s.worker, watchPullRequest: undefined } };
    expect(await ensurePrWatched(basic as never, s.job)).toBe("skipped");
  });

  it("retries after a worker error and stops after T3 refuses a merged PR", async () => {
    const s = await setup();
    s.worker.watchError = "fake: connection reset";
    expect(await ensurePrWatched(s.deps, s.job)).toBe("failed");

    s.worker.watchError = "The pull request is merged, so there is nothing to watch.";
    expect(await ensurePrWatched(s.deps, s.job)).toBe("unwatchable");

    s.worker.watchError = undefined;
    expect(await ensurePrWatched(s.deps, s.job)).toBe("already");
    expect(s.worker.watches).toEqual([]);
  });

  it("posts one thread message per wake and none on a repeat read", async () => {
    const s = await setup();
    s.worker.addWake(s.thread.id, "#12: checks failed");
    s.worker.addWake(s.thread.id, "#12: checks passed");
    const activity = await s.worker.readActivity(s.thread.id, null);

    expect(await reportWakes(s.deps, s.job, activity)).toBe(2);
    expect(await reportWakes(s.deps, s.job, activity)).toBe(2);

    const posts = await s.posts();
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      key: `${jobRef(s.job.id)}:prwake:0`,
      channel: "C1",
      thread_ts: "1690000000.000100",
      text: expect.stringContaining("checks failed"),
    });
    expect(posts[1]?.key).toBe(`${jobRef(s.job.id)}:prwake:1`);
  });

  it("reports only wakes, not the worker's other items", async () => {
    const s = await setup();
    s.worker.addWake(s.thread.id, "#12: new comments");
    const activity = await s.worker.readActivity(s.thread.id, null);
    activity.items.push({ position: 5, type: "assistant_message", text: "Fixing it" });

    expect(await reportWakes(s.deps, s.job, activity)).toBe(1);
  });

  it("checks the thread from its own cursor and reports each wake once", async () => {
    const s = await setup();
    // Not watched yet: no check.
    s.worker.addWake(s.thread.id, "#12: checks failed");
    expect(await checkPrWakes(s.deps, s.job)).toBe(0);

    await ensurePrWatched(s.deps, s.job);
    expect(await checkPrWakes(s.deps, s.job)).toBe(1);
    expect(await checkPrWakes(s.deps, s.job)).toBe(0);

    s.worker.addWake(s.thread.id, "#12: checks passed");
    expect(await checkPrWakes(s.deps, s.job)).toBe(1);
    expect(await s.posts()).toHaveLength(2);
    // The job's own cursor stays as it was.
    expect((await getJob(s.sql, s.job.id))?.cursor).toBe(s.job.cursor);
  });

  it("lists watched jobs that ended recently", async () => {
    const s = await setup();
    await ensurePrWatched(s.deps, s.job);

    const recent = await watchedPrJobs(s.deps, new Date(Date.now() - 3_600_000));
    expect(recent.map((job) => job.id)).toContain(s.job.id);

    const future = await watchedPrJobs(s.deps, new Date(Date.now() + 3_600_000));
    expect(future.map((job) => job.id)).not.toContain(s.job.id);
  });
});
