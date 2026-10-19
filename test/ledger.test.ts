import { describe, expect, it } from "vitest";
import type { DisplayChoice } from "../lib/display.ts";
import {
  activeJobs,
  createJob,
  getJob,
  jobRef,
  type NewJob,
  updateJob,
} from "../lib/ledger/jobs.ts";
import { migrate } from "../lib/ledger/migrate.ts";
import {
  enqueuePost,
  MAX_ATTEMPTS,
  markPostFailed,
  markPostSent,
  pendingPosts,
} from "../lib/ledger/outbox.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const newJob = (title: string, requestKey = `call-${title}-${Math.random()}`): NewJob => ({
  requestKey,
  kind: "code-change",
  title,
  owner: "U-OWNER",
  slackChannel: "C-TEST",
  slackThreadTs: "1700000000.000100",
  brief: { goal: "Add retry with backoff", doneWhen: ["tests pass"] },
  worker: "t3",
  workerProjectId: "project-1",
});

const card: DisplayChoice = { level: 3, target: "thread", reason: "long job with steps" };

describe("jobRef", () => {
  it("formats the job reference used in worker thread titles", () => {
    expect(jobRef(142)).toBe("J-142");
  });
});

describe.skipIf(!hasDatabase)("ledger", () => {
  const ledger = useLedger();

  describe("migrate", () => {
    it("applies nothing on a second run", async () => {
      expect(await migrate(ledger.sql())).toEqual([]);
    });
  });

  describe("jobs", () => {
    it("creates a job in launching with its brief", async () => {
      const job = await createJob(ledger.sql(), newJob("Billing sync retry"));

      expect(job).toMatchObject({
        status: "launching",
        title: "Billing sync retry",
        brief: { goal: "Add retry with backoff", doneWhen: ["tests pass"] },
        workerThreadId: null,
        finishedAt: null,
      });
      expect(typeof job.id).toBe("number");
      expect(await getJob(ledger.sql(), job.id)).toEqual(job);
    });

    it("returns the same job when the request key repeats", async () => {
      const sql = ledger.sql();
      const first = await createJob(sql, newJob("Re-run", "call-rerun"));
      const again = await createJob(sql, newJob("Re-run changed", "call-rerun"));

      expect(again.id).toBe(first.id);
      expect(again.title).toBe("Re-run");
    });

    it("records worker progress and sets finishedAt once at a terminal status", async () => {
      const sql = ledger.sql();
      const job = await createJob(sql, newJob("Progress"));

      const running = await updateJob(sql, job.id, {
        status: "running",
        workerThreadId: "thread-1",
        cursor: "12",
        lastSummary: "Writing code: 3 files changed",
        cardTs: "1700000000.000200",
        display: card,
      });
      expect(running).toMatchObject({
        status: "running",
        workerThreadId: "thread-1",
        cursor: "12",
        display: card,
        finishedAt: null,
      });

      const done = await updateJob(sql, job.id, { status: "done" });
      expect(done.finishedAt).toBeInstanceOf(Date);
      const again = await updateJob(sql, job.id, { lastSummary: "Done in 14m" });
      expect(again.finishedAt).toEqual(done.finishedAt);
    });

    it("keeps a finished job finished when a stale update arrives", async () => {
      const sql = ledger.sql();
      const job = await createJob(sql, newJob("Stale"));
      const done = await updateJob(sql, job.id, { status: "done" });

      const stale = await updateJob(sql, job.id, { status: "running", lastSummary: "late" });

      expect(stale).toMatchObject({ status: "done", lastSummary: "late" });
      expect(stale.finishedAt).toEqual(done.finishedAt);
    });

    it("lists only jobs that still need watching", async () => {
      const sql = ledger.sql();
      const open = await createJob(sql, newJob("Open"));
      const closed = await createJob(sql, newJob("Closed"));
      await updateJob(sql, closed.id, { status: "cancelled" });

      const ids = (await activeJobs(sql)).map((job) => job.id);
      expect(ids).toContain(open.id);
      expect(ids).not.toContain(closed.id);
    });

    it("refuses a second job on the same worker thread", async () => {
      const sql = ledger.sql();
      const first = await createJob(sql, newJob("First"));
      const second = await createJob(sql, newJob("Second"));
      await updateJob(sql, first.id, { workerThreadId: "thread-shared" });

      await expect(updateJob(sql, second.id, { workerThreadId: "thread-shared" })).rejects.toThrow(
        /jobs_worker_thread/,
      );
    });

    it("refuses an unknown status", async () => {
      const sql = ledger.sql();
      const job = await createJob(sql, newJob("Bad status"));
      await expect(updateJob(sql, job.id, { status: "paused" as never })).rejects.toThrow(
        /check constraint/,
      );
    });
  });

  describe("outbox", () => {
    it("enqueues a post once per idempotency key", async () => {
      const sql = ledger.sql();
      const job = await createJob(sql, newJob("Outbox"));
      const post = {
        idempotencyKey: `job-${job.id}:start`,
        jobId: job.id,
        method: "chat.postMessage" as const,
        payload: { channel: "C-TEST", text: "Started" },
        display: card,
      };

      const first = await enqueuePost(sql, post);
      const rerun = await enqueuePost(sql, { ...post, payload: { text: "changed" } });

      expect(rerun.id).toBe(first.id);
      expect(rerun.payload).toEqual({ channel: "C-TEST", text: "Started" });
      expect(first).toMatchObject({ jobId: job.id, status: "pending", display: card });
    });

    it("refuses a post without a display choice", async () => {
      await expect(
        enqueuePost(ledger.sql(), {
          idempotencyKey: "no-display",
          method: "chat.postMessage",
          payload: { text: "hi" },
          display: undefined,
        }),
      ).rejects.toThrow("refuses a post without a display choice");
    });

    it("refuses a silent post", async () => {
      await expect(
        enqueuePost(ledger.sql(), {
          idempotencyKey: "silent",
          method: "chat.postMessage",
          payload: { text: "hi" },
          display: { level: 0, target: "thread", reason: "nothing new" },
        }),
      ).rejects.toThrow("Display level 0 posts nothing");
    });

    it.each([
      ["a missing target and reason", { level: 1 }],
      ["level 0", { level: 0, target: "thread", reason: "nothing new" }],
    ])("backs up the display rule with a database check: %s", async (_case, display) => {
      const sql = ledger.sql();
      await expect(
        sql`
          insert into outbox (idempotency_key, method, payload, display)
          values (${`raw-${display.level}`}, 'chat.postMessage', '{}', ${sql.json(display)})
        `,
      ).rejects.toThrow(/check constraint/);
    });

    it("moves a post from pending to sent", async () => {
      const sql = ledger.sql();
      const post = await enqueuePost(sql, {
        idempotencyKey: "send-me",
        method: "chat.postMessage",
        payload: { text: "Done" },
        display: { level: 1, target: "thread", reason: "short" },
      });
      expect((await pendingPosts(sql, 100)).map((p) => p.id)).toContain(post.id);

      await markPostSent(sql, post.id, "1700000000.000300");

      expect((await pendingPosts(sql, 100)).map((p) => p.id)).not.toContain(post.id);
    });

    it("stops retrying after the last allowed failure", async () => {
      const sql = ledger.sql();
      const post = await enqueuePost(sql, {
        idempotencyKey: "flaky",
        method: "chat.postMessage",
        payload: { text: "Hello" },
        display: { level: 1, target: "thread", reason: "short" },
      });

      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        await markPostFailed(sql, post.id, "ratelimited");
      }
      expect((await pendingPosts(sql, 100)).map((p) => p.id)).toContain(post.id);

      await markPostFailed(sql, post.id, "ratelimited");
      const [row] = await sql`select status, attempts from outbox where id = ${post.id}`;
      expect(row).toEqual({ status: "failed", attempts: MAX_ATTEMPTS });
    });
  });
});
