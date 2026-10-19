import { describe, expect, it } from "vitest";
import type { Brief } from "../lib/jobs/brief.ts";
import { launchOrAdopt } from "../lib/jobs/run.ts";
import { cleanSteerText, STEER_TEXT_MAX, steerJob, stopJob } from "../lib/jobs/steer.ts";
import { createJob, getJob, updateJob } from "../lib/ledger/jobs.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const brief: Brief = {
  project: "test-repo",
  title: "Billing sync retry",
  goal: "Add retry with backoff to the billing sync.",
  constraints: [],
  doneWhen: ["Unit tests cover the retry."],
  baseRef: "main",
  openPullRequest: false,
  estimatedMinutes: 15,
};
const CALLBACK = "http://127.0.0.1:2000/.well-known/workflow/v1/webhook/abc";

describe("cleanSteerText", () => {
  it("strips control characters, collapses space, and caps length", () => {
    expect(cleanSteerText("skip\u0000 the\n\n staging\ttest ")).toBe("skip the staging test");
    expect(cleanSteerText("x".repeat(5_000))).toHaveLength(STEER_TEXT_MAX);
  });
});

describe.skipIf(!hasDatabase)("steer and stop", () => {
  const ledger = useLedger();

  const newJob = (key: string) =>
    createJob(ledger.sql(), {
      requestKey: key,
      kind: "code-change",
      title: brief.title,
      brief,
      worker: "fake",
      slackChannel: "C100",
      slackThreadTs: "1690000000.000100",
      owner: "U100",
    });

  function setup() {
    const worker = new FakeWorker({ script: [{ status: "running" }] });
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let ts = 1;
    const slack: SlackApi = {
      async call(method, body) {
        calls.push({ method, body });
        return { ok: true, ts: method === "chat.postMessage" ? `1700000000.${ts++}` : body.ts };
      },
    };
    return {
      worker,
      calls,
      deps: { sql: ledger.sql(), worker, slack },
      posts: () => calls.filter((c) => c.method === "chat.postMessage"),
    };
  }

  it("sends a steer once and records the summary", async () => {
    const s = setup();
    const job = await newJob("steer-once");
    const launched = await launchOrAdopt(s.deps, job.id, CALLBACK);

    const answer = await steerJob(s.deps, `J-${job.id}`, "skip the staging test");
    await steerJob(s.deps, `J-${job.id}`, "skip the staging test");

    expect(answer).toContain("skip the staging test");
    expect(s.worker.sends).toHaveLength(2);
    expect(s.worker.sends[0]).toMatchObject({
      threadId: launched.workerThreadId,
      mode: "steer",
    });
    expect(s.worker.sends[0]?.text).toContain("skip the staging test");
    // Without a tool call ID, the text keys the request, so the worker deduplicates a retry.
    expect(s.worker.sends[1]?.requestId).toBe(s.worker.sends[0]?.requestId);
    expect(s.worker.sends[0]?.requestId).toMatch(new RegExp(`^steer-J-${job.id}-[0-9a-f]{12}$`));
    expect((await getJob(ledger.sql(), job.id))?.lastSummary).toBe(
      "Steered: skip the staging test",
    );

    await steerJob(s.deps, `J-${job.id}`, "also skip lint");
    expect(s.worker.sends[2]?.requestId).not.toBe(s.worker.sends[0]?.requestId);
  });

  it("treats the same words in a new tool call as a new request", async () => {
    const s = setup();
    const job = await newJob("steer-calls");
    await launchOrAdopt(s.deps, job.id, CALLBACK);

    await steerJob(s.deps, `J-${job.id}`, "rerun the tests", "steer", "call-1");
    await steerJob(s.deps, `J-${job.id}`, "rerun the tests", "steer", "call-1");
    await steerJob(s.deps, `J-${job.id}`, "rerun the tests", "steer", "call-2");

    const ids = s.worker.sends.map((send) => send.requestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("refuses unknown, unlaunched, and finished jobs", async () => {
    const s = setup();
    expect(await steerJob(s.deps, "J-999999", "go")).toContain("no job");

    const unlaunched = await newJob("steer-unlaunched");
    expect(await steerJob(s.deps, `J-${unlaunched.id}`, "go")).toContain("not started");
    expect(await stopJob(s.deps, `J-${unlaunched.id}`)).toContain("not started");

    const finished = await newJob("steer-finished");
    await launchOrAdopt(s.deps, finished.id, CALLBACK);
    await updateJob(ledger.sql(), finished.id, { status: "done" });
    expect(await steerJob(s.deps, `J-${finished.id}`, "go")).toContain("already finished");
    expect(await stopJob(s.deps, `J-${finished.id}`)).toContain("already finished");

    expect(s.worker.sends).toEqual([]);
    expect(s.worker.interrupts).toEqual([]);
  });

  it("stops a running job: one interrupt and one cancel post", async () => {
    const s = setup();
    const job = await newJob("stop");
    await launchOrAdopt(s.deps, job.id, CALLBACK);
    const before = s.posts().length;

    const answer = await stopJob(s.deps, `J-${job.id}`);
    const again = await stopJob(s.deps, `J-${job.id}`);

    expect(answer).toBe(`Stopped J-${job.id}.`);
    expect(again).toContain("already finished");
    expect(s.worker.interrupts).toHaveLength(1);
    expect(s.posts().length - before).toBe(1);
    expect(await getJob(ledger.sql(), job.id)).toMatchObject({ status: "cancelled" });
  });
});
