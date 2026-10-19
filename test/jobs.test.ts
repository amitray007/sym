import { describe, expect, it } from "vitest";
import { type Brief, workerMessage } from "../lib/jobs/brief.ts";
import {
  cancelJob,
  checkJob,
  failJob,
  launchOrAdopt,
  STATUS_LINE_MAX,
  statusLine,
} from "../lib/jobs/run.ts";
import { createJob, getJob } from "../lib/ledger/jobs.ts";
import { type FakeStep, FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const brief: Brief = {
  project: "test-repo",
  title: "Billing sync retry",
  goal: "Add retry with backoff to the billing sync.",
  constraints: ["Touch only src/sync."],
  doneWhen: ["Unit tests cover the retry."],
  baseRef: "main",
  openPullRequest: false,
};

const CALLBACK = "http://127.0.0.1:2000/.well-known/workflow/v1/webhook/abc";

describe("workerMessage", () => {
  it("carries the brief, the guardrails, the output contract, and the callback", () => {
    const message = workerMessage(brief, "J-7", CALLBACK);

    expect(message).toContain("Sym job J-7: Billing sync retry");
    expect(message).toContain("- Touch only src/sync.");
    expect(message).toContain("- Keep production systems and customer data read-only.");
    expect(message).toContain("Do not push and do not open a pull request.");
    expect(message).toContain('"pr_url": null');
    expect(message).toContain(`curl -fsS -X POST '${CALLBACK}'`);
  });

  it("asks for a draft PR only when the brief allows it", () => {
    const message = workerMessage({ ...brief, openPullRequest: true }, "J-7", CALLBACK);
    expect(message).toContain("push it, and open a draft pull request");
  });
});

describe("statusLine", () => {
  it("keeps a short line as it is", () => {
    expect(statusLine("J-7", "Tests running")).toBe("J-7: Tests running");
  });

  it("cuts a long line to the Slack status limit", () => {
    const line = statusLine("J-7", "Writing code in many files across the whole repository");
    expect(line).toHaveLength(STATUS_LINE_MAX);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe.skipIf(!hasDatabase)("worker job steps", () => {
  const ledger = useLedger();

  const newJob = (requestKey: string) =>
    createJob(ledger.sql(), {
      requestKey,
      kind: "code-change",
      title: brief.title,
      brief,
      worker: "fake",
    });

  const deps = (worker: FakeWorker) => ({ sql: ledger.sql(), worker });

  describe("launchOrAdopt", () => {
    it("launches one thread titled with the job reference", async () => {
      const worker = new FakeWorker();
      const job = await newJob("launch-once");

      const launched = await launchOrAdopt(deps(worker), job.id, CALLBACK);

      expect(launched).toMatchObject({ status: "running", workerProjectId: "project-1" });
      const thread = worker.threads.get(launched.workerThreadId ?? "");
      expect(thread?.request.title).toBe(`[J-${job.id}] Billing sync retry`);
      expect(thread?.request.message).toContain(CALLBACK);
      expect(thread?.request.baseRef).toBe("main");
    });

    it("does not launch again when the step re-runs", async () => {
      const worker = new FakeWorker();
      const job = await newJob("rerun");

      const first = await launchOrAdopt(deps(worker), job.id, CALLBACK);
      const again = await launchOrAdopt(deps(worker), job.id, CALLBACK);

      expect(again.workerThreadId).toBe(first.workerThreadId);
      expect(worker.launches).toBe(1);
    });

    it("adopts the thread when the launch response was lost", async () => {
      const worker = new FakeWorker({ loseNextLaunchResponse: true });
      const job = await newJob("lost-response");

      await expect(launchOrAdopt(deps(worker), job.id, CALLBACK)).rejects.toThrow("lost");
      expect((await getJob(ledger.sql(), job.id))?.workerThreadId).toBeNull();

      const adopted = await launchOrAdopt(deps(worker), job.id, CALLBACK);

      expect(worker.launches).toBe(1);
      expect(adopted.workerThreadId).toBe([...worker.threads.keys()][0]);
    });

    it("launches once when two copies of the call run at the same time", async () => {
      const worker = new FakeWorker();
      const job = await newJob("concurrent");

      const [a, b] = await Promise.all([
        launchOrAdopt(deps(worker), job.id, CALLBACK),
        launchOrAdopt(deps(worker), job.id, CALLBACK),
      ]);

      expect(worker.launches).toBe(1);
      expect(a.workerThreadId).toBe(b.workerThreadId);
    });

    it("refuses a project the worker does not know", async () => {
      const worker = new FakeWorker();
      const job = await createJob(ledger.sql(), {
        requestKey: "unknown-project",
        kind: "code-change",
        title: "Nowhere",
        brief: { ...brief, project: "missing-repo" },
        worker: "fake",
      });

      await expect(launchOrAdopt(deps(worker), job.id, CALLBACK)).rejects.toThrow(
        'The worker has no project "missing-repo".',
      );
      expect(worker.launches).toBe(0);
    });
  });

  describe("checkJob", () => {
    const run = async (requestKey: string, script: FakeStep[]) => {
      const worker = new FakeWorker({ script });
      const job = await newJob(requestKey);
      await launchOrAdopt(deps(worker), job.id, CALLBACK);
      return { worker, job };
    };

    it("records progress, then ends with the last worker message", async () => {
      const { worker, job } = await run("progress", [
        { status: "running", items: ["Writing code: 3 files changed\nmore detail"] },
        { status: "completed", items: ['Done.\n```json\n{"summary": "Added retry"}\n```'] },
      ]);

      const first = await checkJob(deps(worker), job.id, 1000);
      expect(first).toEqual({
        status: "running",
        summary: "Writing code: 3 files changed",
        terminal: false,
        lastMessage: null,
      });
      expect((await getJob(ledger.sql(), job.id))?.cursor).toBe("0");

      const last = await checkJob(deps(worker), job.id, 1000);
      expect(last).toMatchObject({ status: "done", summary: "Done.", terminal: true });
      expect(last.lastMessage).toContain('"summary": "Added retry"');
      expect((await getJob(ledger.sql(), job.id))?.finishedAt).toBeInstanceOf(Date);
    });

    it("keeps the final message when the status ends in a later check", async () => {
      const { worker, job } = await run("late-status", [
        { status: "running", items: ['Done.\n```json\n{"summary": "Added retry"}\n```'] },
        { status: "completed" },
      ]);

      expect((await checkJob(deps(worker), job.id, 1000)).lastMessage).toBeNull();
      const last = await checkJob(deps(worker), job.id, 1000);

      expect(last.status).toBe("done");
      expect(last.lastMessage).toContain('"summary": "Added retry"');
    });

    it("keeps the last summary when the worker has nothing new", async () => {
      const { worker, job } = await run("quiet", [
        { status: "running", items: ["Tests running"] },
        { status: "running" },
      ]);

      await checkJob(deps(worker), job.id, 1000);
      const second = await checkJob(deps(worker), job.id, 1000);

      expect(second).toMatchObject({ status: "running", summary: "Tests running" });
    });

    it("marks an interrupted worker thread as failed", async () => {
      const { worker, job } = await run("interrupted", [{ status: "interrupted" }]);

      expect(await checkJob(deps(worker), job.id, 1000)).toMatchObject({
        status: "failed",
        summary: "Worker thread interrupted",
        terminal: true,
      });
    });

    it("keeps the job state when the worker state is unknown", async () => {
      const { worker, job } = await run("unknown", [{ status: "unknown" }]);
      expect((await checkJob(deps(worker), job.id, 1000)).status).toBe("running");
    });

    it("does not call the worker for a finished job", async () => {
      const { worker, job } = await run("finished", [{ status: "completed", items: ["Done"] }]);
      await checkJob(deps(worker), job.id, 1000);

      // This fake has no such thread, so any worker call would throw.
      const again = await checkJob(deps(new FakeWorker()), job.id, 1000);

      expect(again).toEqual({
        status: "done",
        summary: "Done",
        terminal: true,
        lastMessage: "Done",
      });
    });
  });

  describe("cancelJob", () => {
    it("interrupts the worker thread and records the job as cancelled", async () => {
      const worker = new FakeWorker({ script: [{ status: "running" }] });
      const job = await newJob("cancel");
      const launched = await launchOrAdopt(deps(worker), job.id, CALLBACK);

      const result = await cancelJob(deps(worker), job.id);

      expect(result).toMatchObject({ status: "cancelled", terminal: true });
      expect(worker.interrupts).toEqual([
        { threadId: launched.workerThreadId, requestId: `cancel-J-${job.id}` },
      ]);
    });

    it("does not interrupt a job that already finished", async () => {
      const worker = new FakeWorker({ script: [{ status: "completed", items: ["Done"] }] });
      const job = await newJob("cancel-finished");
      await launchOrAdopt(deps(worker), job.id, CALLBACK);
      await checkJob(deps(worker), job.id, 1000);

      const result = await cancelJob(deps(worker), job.id);

      expect(result.status).toBe("done");
      expect(worker.interrupts).toEqual([]);
    });
  });

  describe("failJob", () => {
    it("records a failed task on a job that never launched", async () => {
      const job = await newJob("fail");
      await failJob(ledger.sql(), job.id, 'The worker has no project "x".');
      expect(await getJob(ledger.sql(), job.id)).toMatchObject({
        status: "failed",
        lastSummary: 'The worker has no project "x".',
      });
    });
  });
});
