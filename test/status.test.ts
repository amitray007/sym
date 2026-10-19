import { describe, expect, it } from "vitest";
import { jobAnswer, jobListAnswer } from "../lib/jobs/status.ts";
import {
  createJob,
  getJobByRef,
  type Job,
  type JobStatus,
  recentJobs,
  updateJob,
} from "../lib/ledger/jobs.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const NOW = new Date("2026-03-02T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 12,
    requestKey: "k",
    sessionId: null,
    kind: "code-change",
    title: "Billing sync retry",
    status: "running",
    owner: null,
    slackChannel: null,
    slackThreadTs: null,
    brief: {},
    worker: "t3",
    workerProjectId: null,
    workerThreadId: "thread-1",
    cursor: null,
    lastSummary: null,
    lastMessage: null,
    cardTs: null,
    card: null,
    cardVersion: 0,
    cardSentVersion: 0,
    display: null,
    prUrl: null,
    startedAt: minutesAgo(14),
    lastActivityAt: null,
    quietNoticedAt: null,
    watchUntil: null,
    createdAt: minutesAgo(15),
    updatedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

describe("jobAnswer", () => {
  it("answers for a running job with its last summary", () => {
    const answer = jobAnswer(job({ lastSummary: "Writing the retry loop" }), NOW);
    expect(answer).toBe("J-12 Billing sync retry: running for 14m.\nLast: Writing the retry loop");
  });

  it("measures from creation when the job never started", () => {
    expect(jobAnswer(job({ startedAt: null }), NOW)).toBe(
      "J-12 Billing sync retry: running for 15m.",
    );
  });

  it("says what a job waiting for an answer needs", () => {
    expect(jobAnswer(job({ status: "waiting_input" }), NOW)).toBe(
      "J-12 Billing sync retry: waiting for you for 14m.\n" +
        "Waiting for your answer to the worker's question.",
    );
  });

  it("says what a job blocked on a permission prompt needs", () => {
    expect(jobAnswer(job({ status: "waiting_permission", lastSummary: "Needs shell" }), NOW)).toBe(
      "J-12 Billing sync retry: blocked on a permission prompt for 14m.\n" +
        "Last: Needs shell\n" +
        "Waiting for a permission prompt on the worker. Approve it in T3.",
    );
  });

  it("shows the finish age and the PR for a done job", () => {
    const answer = jobAnswer(
      job({
        status: "done",
        finishedAt: minutesAgo(3),
        lastSummary: "Added retry",
        prUrl: "https://github.com/example/widgets/pull/42",
      }),
      NOW,
    );
    expect(answer).toBe(
      "J-12 Billing sync retry: done 3m ago.\n" +
        "Last: Added retry\n" +
        "PR: https://github.com/example/widgets/pull/42",
    );
  });

  it("shows a failed job with its reason and no waiting line", () => {
    const answer = jobAnswer(
      job({
        status: "failed",
        finishedAt: minutesAgo(90),
        lastSummary: "Worker thread interrupted",
      }),
      NOW,
    );
    expect(answer).toBe(
      "J-12 Billing sync retry: failed 1h 30m ago.\nLast: Worker thread interrupted",
    );
  });

  it.each<[JobStatus, string]>([
    ["launching", "Waiting for Start on the brief."],
    ["worker_offline", "Waiting for the worker to come back."],
    ["quiet", "No new worker activity for a while."],
  ])("adds a waiting line for %s", (status, line) => {
    expect(jobAnswer(job({ status }), NOW).split("\n").at(-1)).toBe(line);
  });
});

describe("jobListAnswer", () => {
  it("says so when there is nothing to list", () => {
    expect(jobListAnswer([], NOW)).toBe("No active jobs, and none finished today.");
  });

  it("lists one line per job", () => {
    const list = jobListAnswer(
      [
        job({
          id: 13,
          title: "Docs pass",
          status: "waiting_input",
          lastSummary: "Asked a question",
        }),
        job({ id: 12, status: "done", finishedAt: minutesAgo(5) }),
      ],
      NOW,
    );
    expect(list).toBe(
      "J-13 Docs pass: waiting for you for 14m · Asked a question\n" +
        "J-12 Billing sync retry: done 5m ago",
    );
  });
});

describe.skipIf(!hasDatabase)("job lookups", () => {
  const ledger = useLedger();

  const make = (requestKey: string) =>
    createJob(ledger.sql(), {
      requestKey,
      kind: "code-change",
      title: requestKey,
      brief: {},
      worker: "t3",
    });

  describe("getJobByRef", () => {
    it("finds a job by J-n, n, and a lowercase reference", async () => {
      const created = await make("ref-job");
      for (const ref of [
        `J-${created.id}`,
        String(created.id),
        `j-${created.id}`,
        ` J-${created.id} `,
      ]) {
        expect((await getJobByRef(ledger.sql(), ref))?.id).toBe(created.id);
      }
    });

    it("returns nothing for text that is not a reference or an unknown job", async () => {
      expect(await getJobByRef(ledger.sql(), "x")).toBeUndefined();
      expect(await getJobByRef(ledger.sql(), "J-")).toBeUndefined();
      expect(await getJobByRef(ledger.sql(), "J-999999")).toBeUndefined();
    });
  });

  describe("recentJobs", () => {
    it("returns active jobs and jobs finished since the date, not older finished jobs", async () => {
      const sql = ledger.sql();
      const active = await make("recent-active");
      const fresh = await make("recent-fresh");
      const old = await make("recent-old");
      await updateJob(sql, fresh.id, { status: "done" });
      await updateJob(sql, old.id, { status: "failed" });
      await sql`update jobs set finished_at = now() - interval '3 days' where id = ${old.id}`;
      const since = new Date(Date.now() - 24 * 3_600_000);

      const ids = (await recentJobs(sql, since)).map((j) => j.id);

      expect(ids).toContain(active.id);
      expect(ids).toContain(fresh.id);
      expect(ids).not.toContain(old.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
    });

    it("respects the limit and keeps the newest", async () => {
      const sql = ledger.sql();
      const a = await make("limit-a");
      const b = await make("limit-b");
      const ids = (await recentJobs(sql, new Date(0), 2)).map((j) => j.id);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBeGreaterThanOrEqual(Math.max(a.id, b.id));
    });
  });
});
