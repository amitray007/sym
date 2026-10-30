import { describe, expect, it } from "vitest";
import { jobReply } from "../lib/jobs/names.ts";
import { freshJobStatus, jobAnswer, jobListAnswer } from "../lib/jobs/status.ts";
import {
  createJob,
  getJobByRef,
  type Job,
  type JobStatus,
  recentJobs,
  updateJob,
} from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const NOW = new Date("2026-03-02T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 12,
    parentJobId: null,
    followupSentAt: null,
    followupBoundary: null,
    followupChecks: 0,
    followupObserved: false,
    requestKey: "k",
    sessionId: null,
    kind: "code-change",
    title: "Billing sync retry",
    status: "running",
    owner: null,
    slackChannel: null,
    slackThreadTs: null,
    codeChannel: false,
    closedAt: null,
    workerSettledAt: null,
    archiveState: "none",
    archiveError: null,
    originChannel: null,
    originThreadTs: null,
    brief: {},
    worker: "t3",
    workerIdentity: null,
    workerProjectId: null,
    workerThreadId: "thread-1",
    workerModel: null,
    cursor: null,
    lastSummary: null,
    skipping: null,
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
    revision: 0,
    verdict: null,
    prFacts: null,
    endPresentedAt: null,
    createdAt: minutesAgo(15),
    updatedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

describe("jobAnswer", () => {
  it("answers for a running job with its last summary", () => {
    const answer = jobAnswer(job({ lastSummary: "Writing the retry loop" }), NOW);
    expect(answer).toBe("Billing sync retry: running for 14m.\nWriting the retry loop");
  });

  it("uses this in the job's own conversation and a linked title elsewhere", () => {
    const named = job({ slackChannel: "C1", slackThreadTs: "170.1" });
    expect(jobAnswer(named, NOW, true)).toBe("This is running for 14m.");
    expect(jobAnswer(named, NOW)).toBe(
      "<https://slack.com/app_redirect?channel=C1&message_ts=170.1|Billing sync retry>: running for 14m.",
    );
    expect(jobListAnswer([named], NOW)).toBe(
      "<https://slack.com/app_redirect?channel=C1&message_ts=170.1|Billing sync retry>: running for 14m.",
    );
  });

  it("measures from creation when the job never started", () => {
    expect(jobAnswer(job({ startedAt: null }), NOW)).toBe("Billing sync retry: running for 15m.");
  });

  it("says what a job waiting for an answer needs", () => {
    expect(jobAnswer(job({ status: "waiting_input" }), NOW)).toBe(
      "Billing sync retry: waiting for you for 14m.\n" +
        "Waiting for your answer to the worker's question.",
    );
  });

  it("says what a job blocked on a permission prompt needs", () => {
    expect(jobAnswer(job({ status: "waiting_permission", lastSummary: "Needs shell" }), NOW)).toBe(
      "Billing sync retry: blocked on a permission prompt for 14m.\n" +
        "Needs shell\n" +
        "Waiting for a permission prompt on the worker. Approve it in the worker.",
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
      "Billing sync retry: done 3m ago.\n" +
        "Added retry\n" +
        "https://github.com/example/widgets/pull/42",
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
    expect(answer).toBe("Billing sync retry: failed 1h 30m ago.\nWorker thread interrupted");
  });

  it.each<[JobStatus, string]>([
    ["launching", "Waiting for you to start it."],
    ["worker_offline", "Waiting for the worker to come back."],
    ["quiet", "I haven't heard from the worker. I'm still checking."],
  ])("adds a waiting line for %s", (status, line) => {
    expect(jobAnswer(job({ status }), NOW).split("\n").at(-1)).toBe(line);
  });
});

describe("jobListAnswer", () => {
  it("says so when there is nothing to list", () => {
    expect(jobListAnswer([], NOW)).toBe("no active jobs, and none finished today.");
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
      "Docs pass: waiting for you for 14m. · Asked a question\n" +
        "Billing sync retry: done 5m ago.",
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

  it("labels a failed refresh as last-known data without changing saved facts", async () => {
    const sql = ledger.sql();
    const created = await make("refresh-failed");
    const running = await updateJob(sql, created.id, {
      status: "running",
      workerThreadId: "thread-refresh",
      lastSummary: "Running tests",
    });
    const status = await freshJobStatus(sql, `J-${created.id}`, NOW, async () => {
      throw new Error("offline");
    });
    expect(status).toMatchObject({
      freshRead: "failed",
      ledgerStatus: "running",
      updatedAt: running.updatedAt.toISOString(),
    });
    expect(status?.answer).toContain("last saved update");
    expect((await getJobByRef(sql, `J-${created.id}`))?.updatedAt).toEqual(running.updatedAt);
  });

  it("keeps the tool handle separate from a contextual status answer", async () => {
    const sql = ledger.sql();
    const created = await createJob(sql, {
      requestKey: "contextual-status",
      kind: "code-change",
      title: "Billing sync retry",
      brief: {},
      worker: "t3",
      slackChannel: "C1",
      slackThreadTs: "170.1",
    });
    const read = (conversation?: { channelId: string; threadTs: string | null }) =>
      freshJobStatus(sql, `J-${created.id}`, NOW, async () => {}, conversation);
    const own = await read({ channelId: "C1", threadTs: "170.1" });
    await recordSessionThread(sql, {
      sessionId: "own-action",
      teamId: "T1",
      channelId: "C1",
      threadTs: "170.1",
      userId: "U1",
    });
    expect(
      await jobReply(sql, `J-${created.id}`, "own-action", "This can't take a follow-up now."),
    ).toBe("This can't take a follow-up now.");
    expect(
      await jobReply(sql, `J-${created.id}`, "elsewhere", "This can't take a follow-up now."),
    ).toBe(
      "<https://slack.com/app_redirect?channel=C1&message_ts=170.1|Billing sync retry>: This can't take a follow-up now.",
    );
    expect(own?.job).toBe(`J-${created.id}`);
    expect(own?.answer).toMatch(/^This is not started/);
    expect((await read({ channelId: "D1", threadTs: null }))?.answer).toMatch(
      /^<https:.*\|Billing sync retry>:/,
    );
    await updateJob(sql, created.id, { codeChannel: true, slackThreadTs: null });
    expect((await read({ channelId: "C1", threadTs: "180.1" }))?.answer).toMatch(
      /^This is not started/,
    );
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
