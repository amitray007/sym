import { describe, expect, it } from "vitest";
import { type Brief, workerMessage } from "../lib/jobs/brief.ts";
import {
  answerQuestion,
  cancelJob,
  checkJob,
  closeUnlaunched,
  failJob,
  type JobDeps,
  launchOrAdopt,
  parseWorkerModel,
  STATUS_LINE_MAX,
  startJob,
  statusLine,
} from "../lib/jobs/run.ts";
import { createJob, getJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { type FakeStep, FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const brief: Brief = {
  project: "test-repo",
  title: "Billing sync retry",
  goal: "Add retry with backoff to the billing sync.",
  constraints: ["Touch only src/sync."],
  doneWhen: ["Unit tests cover the retry."],
  baseRef: "main",
  openPullRequest: false,
  estimatedMinutes: 15,
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

describe("parseWorkerModel", () => {
  it("splits the provider from the model", () => {
    expect(parseWorkerModel("codex/gpt-6-luna")).toEqual({
      providerId: "codex",
      model: "gpt-6-luna",
    });
  });

  it("returns nothing when unset", () => {
    expect(parseWorkerModel(undefined)).toBeUndefined();
    expect(parseWorkerModel("  ")).toBeUndefined();
  });

  it.each(["codex", "/gpt-6-luna", "codex/"])("rejects %s", (value) => {
    expect(() => parseWorkerModel(value)).toThrow("must look like <provider>/<model>");
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

  const deps = (worker: FakeWorker) => ({
    sql: ledger.sql(),
    worker,
    allowedProjects: TEST_PROJECTS,
  });

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

      // An allowed project the worker lacks: the message names only that allowed project.
      const allowed = [{ name: "missing-repo", workerProject: "missing-repo" }];
      await expect(
        launchOrAdopt({ ...deps(worker), allowedProjects: allowed }, job.id, CALLBACK),
      ).rejects.toThrow('The worker has no project "missing-repo".');
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
        questions: [],
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
        questions: [],
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
      await failJob({ sql: ledger.sql() }, job.id, 'The worker has no project "x".');
      expect(await getJob(ledger.sql(), job.id)).toMatchObject({
        status: "failed",
        lastSummary: 'The worker has no project "x".',
      });
    });
  });
});

// Records Sym's Slack calls and answers like Slack.
function fakeSlack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextTs = 1;
  const api: SlackApi = {
    async call(method, body) {
      calls.push({ method, body });
      if (method === "chat.postMessage") return { ok: true, ts: `1700000000.${nextTs++}` };
      return { ok: true, ts: body.ts };
    },
  };
  return {
    api,
    calls,
    posts: () => calls.filter((c) => c.method === "chat.postMessage"),
    updates: () => calls.filter((c) => c.method === "chat.update"),
  };
}

const T0 = new Date("2026-03-02T10:00:00.000Z");
const CHANNEL = "C100";
const THREAD_TS = "1690000000.000100";
const OWNER = "U100";
const PR_URL = "https://github.com/example/widgets/pull/42";
const FINAL = `All set.\n\`\`\`json\n${JSON.stringify({
  summary: "Added retry with backoff",
  pr_url: PR_URL,
  tests: "12 passed",
  files_changed: ["src/sync.ts", "src/sync.test.ts"],
  open_questions: [],
})}\n\`\`\``;
const QUESTION = {
  requestId: "req-1",
  questions: [
    {
      id: "q1",
      prompt: "Use exponential backoff?",
      options: [{ label: "Yes" }, { label: "No" }],
      multiSelect: false,
    },
  ],
};

describe.skipIf(!hasDatabase)("job steps in Slack", () => {
  const ledger = useLedger();
  let keyCounter = 0;
  let clock = T0;

  interface SetupOptions {
    script?: FakeStep[];
    brief?: Partial<Brief>;
    withThread?: boolean;
  }

  // Starts a job as `t3_job` does, from a recorded Slack thread, and returns its deps.
  async function setup(options: SetupOptions = {}) {
    clock = T0;
    const n = ++keyCounter;
    const sql = ledger.sql();
    const sessionId = `session-${n}`;
    if (options.withThread !== false) {
      await recordSessionThread(sql, {
        sessionId,
        teamId: "T1",
        channelId: CHANNEL,
        threadTs: THREAD_TS,
        userId: OWNER,
      });
    }
    const worker = new FakeWorker({ script: options.script ?? [{ status: "running" }] });
    const slack = fakeSlack();
    const deps: JobDeps = {
      sql,
      worker,
      allowedProjects: TEST_PROJECTS,
      slack: slack.api,
      now: () => clock,
    };
    const job = await startJob(sql, {
      requestKey: `slack-${n}`,
      sessionId,
      brief: { ...brief, ...options.brief },
    });
    return { sql, worker, slack, deps, job, ref: `J-${job.id}` };
  }

  const launched = async (options: SetupOptions = {}) => {
    const s = await setup(options);
    const job = await launchOrAdopt(s.deps, s.job.id, CALLBACK);
    return { ...s, job };
  };
  const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);
  const texts = (calls: { body: Record<string, unknown> }[]) => calls.map((c) => c.body.text);

  it("copies the Slack origin from the session thread onto the job", async () => {
    const { job } = await setup();
    expect(job).toMatchObject({
      slackChannel: CHANNEL,
      slackThreadTs: THREAD_TS,
      owner: OWNER,
    });
  });

  it("gives a job without a session thread no Slack target and posts nothing", async () => {
    const { job, slack, deps } = await setup({ withThread: false });
    expect(job).toMatchObject({ slackChannel: null, slackThreadTs: null, owner: null });

    await launchOrAdopt(deps, job.id, CALLBACK);

    expect(slack.calls).toEqual([]);
  });

  it("posts one plan-block card for a long job and none when the launch re-runs", async () => {
    const { deps, job: fresh, slack, sql, ref } = await setup();

    const job = await launchOrAdopt(deps, fresh.id, CALLBACK);
    await launchOrAdopt(deps, fresh.id, CALLBACK);

    expect(slack.calls).toHaveLength(1);
    const post = slack.posts()[0]?.body;
    expect(post).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
    const blocks = post?.blocks as { type: string; title: string }[];
    expect(blocks[0]?.type).toBe("plan");
    expect(blocks[0]?.title).toContain(`[${ref}] Billing sync retry`);
    const stored = await getJob(sql, job.id);
    expect(stored?.cardTs).toBe("1700000000.1");
    expect(stored?.display?.level).toBe(3);
  });

  it("posts one Started line for a short job instead of a card", async () => {
    const { deps, job: fresh, slack, sql, ref } = await setup({ brief: { estimatedMinutes: 1 } });

    await launchOrAdopt(deps, fresh.id, CALLBACK);

    expect(slack.calls).toHaveLength(1);
    expect(slack.posts()[0]?.body).toMatchObject({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: `Started ${ref}: Billing sync retry`,
    });
    expect((await getJob(sql, fresh.id))?.cardTs).toBeNull();
  });

  describe("progress", () => {
    it("edits the card in place and posts no new message while the job runs", async () => {
      const s = await launched({
        script: [
          { status: "running", items: ["Reading the sync module"] },
          { status: "running", items: ["Writing the retry loop"] },
        ],
      });
      const cardTs = (await getJob(s.sql, s.job.id))?.cardTs;
      expect(cardTs).toBe("1700000000.1");
      const before = s.slack.calls.length;

      clock = minutes(1);
      await checkJob(s.deps, s.job.id, 1000);
      clock = minutes(2);
      await checkJob(s.deps, s.job.id, 1000);

      const added = s.slack.calls.slice(before);
      expect(added.map((c) => c.method)).toEqual(["chat.update", "chat.update"]);
      for (const call of added) expect(call.body).toMatchObject({ channel: CHANNEL, ts: cardTs });
      const blockIds = added.map((c) => (c.body.blocks as { block_id: string }[])[0]?.block_id);
      expect(new Set(blockIds).size).toBe(2);
      expect(blockIds).not.toContain(`job-${s.ref}-v1`);
      expect(JSON.stringify(added[1]?.body.blocks)).toContain("Writing the retry loop");
    });

    // Known bug: liveCard puts cardVersion + 1 in block_id, so an unchanged card still differs
    // and setJobCard bumps the version on every check (lib/jobs/present.ts liveCard).
    it("does not edit the card when a check changes nothing", async () => {
      const s = await launched({
        script: [{ status: "running", items: ["Reading the sync module"] }, { status: "running" }],
      });
      clock = minutes(1);
      await checkJob(s.deps, s.job.id, 1000);
      const before = s.slack.calls.length;

      await checkJob(s.deps, s.job.id, 1000);

      expect(s.slack.calls.slice(before)).toEqual([]);
    });
  });

  describe("completion", () => {
    it("collapses the card and posts one result message from the output contract", async () => {
      const s = await launched({
        script: [
          { status: "running", items: ["Working"] },
          { status: "completed", items: [FINAL] },
        ],
      });
      const cardTs = (await getJob(s.sql, s.job.id))?.cardTs;
      await checkJob(s.deps, s.job.id, 1000);
      const before = s.slack.calls.length;

      clock = minutes(9);
      const result = await checkJob(s.deps, s.job.id, 1000);

      expect(result).toMatchObject({ status: "done", terminal: true });
      const added = s.slack.calls.slice(before);
      const collapse = added.filter((c) => c.method === "chat.update");
      expect(collapse).toHaveLength(1);
      expect(collapse[0]?.body).toMatchObject({ channel: CHANNEL, ts: cardTs });
      expect(collapse[0]?.body.text).toBe(`[${s.ref}] Billing sync retry · Done in 9m · PR #42`);
      // The thread gets one end message: the result carries the PR, so no separate PR line.
      const posts = added.filter((c) => c.method === "chat.postMessage");
      expect(posts).toHaveLength(1);
      const text = String(posts[0]?.body.text);
      expect(posts[0]?.body).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
      expect(text).toContain(`${s.ref} done in 9m`);
      expect(text).toContain("Added retry with backoff");
      expect(text).toContain(`Draft PR: <${PR_URL}|PR #42>`);
      expect(text).toContain("Tests: 12 passed");
      expect(text).toContain("2 files changed");
    });

    it("builds the result when the final message arrived one check before the status", async () => {
      const s = await launched({
        script: [{ status: "running", items: [FINAL] }, { status: "completed" }],
      });
      await checkJob(s.deps, s.job.id, 1000);
      const before = s.slack.calls.length;

      clock = minutes(3);
      await checkJob(s.deps, s.job.id, 1000);

      const posts = s.slack
        .posts()
        .slice(s.slack.posts().length - 1)
        .map((c) => String(c.body.text));
      expect(
        s.slack.calls.slice(before).filter((c) => c.method === "chat.postMessage"),
      ).toHaveLength(1);
      expect(posts[0]).toContain("Added retry with backoff");
      expect(posts[0]).toContain(`<${PR_URL}|PR #42>`);
    });

    it("posts a plain notice when the worker sent no output contract", async () => {
      const s = await launched({ script: [{ status: "completed", items: ["Finished it."] }] });
      await checkJob(s.deps, s.job.id, 1000);

      expect(String(s.slack.posts().at(-1)?.body.text)).toContain("sent no result summary");
    });
  });

  it("posts one pull request message when a PR URL shows in activity", async () => {
    const s = await launched({
      script: [
        { status: "running", items: [`Opened ${PR_URL}`] },
        { status: "running", items: ["Still polishing"] },
        { status: "running", items: [`See ${PR_URL} again`] },
      ],
    });
    const before = s.slack.posts().length;

    for (let i = 1; i <= 3; i++) {
      clock = minutes(i);
      await checkJob(s.deps, s.job.id, 1000);
    }

    const added = s.slack.posts().slice(before);
    expect(texts(added)).toEqual([`${s.ref} opened a pull request: <${PR_URL}>`]);
    expect((await getJob(s.sql, s.job.id))?.prUrl).toBe(PR_URL);
  });

  describe("waiting", () => {
    it("reports a worker question without a DM and sends the answer once", async () => {
      const s = await launched({
        script: [{ status: "waiting", questions: [QUESTION] }],
      });
      const before = s.slack.posts().length;

      const check = await checkJob(s.deps, s.job.id, 1000);

      expect(check.status).toBe("waiting_input");
      expect(check.questions).toEqual([QUESTION]);
      expect(s.slack.posts().slice(before)).toEqual([]);

      await answerQuestion(s.deps, s.job.id, "req-1", { q1: "Yes" });
      await answerQuestion(s.deps, s.job.id, "req-1", { q1: "Yes" });

      expect(s.worker.answers).toHaveLength(1);
      expect(s.worker.answers[0]).toMatchObject({ requestId: "req-1", answers: { q1: "Yes" } });
      expect((await getJob(s.sql, s.job.id))?.status).toBe("running");
    });

    it("sends one DM to the owner for a permission prompt, not again for the same state", async () => {
      const s = await launched({
        script: [
          { status: "waiting", pendingRequests: 1 },
          { status: "waiting", pendingRequests: 1 },
        ],
      });
      const before = s.slack.posts().length;

      clock = minutes(1);
      const first = await checkJob(s.deps, s.job.id, 1000);
      clock = minutes(2);
      await checkJob(s.deps, s.job.id, 1000);

      expect(first).toMatchObject({ status: "waiting_permission", questions: [] });
      const added = s.slack.posts().slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]?.body.channel).toBe(OWNER);
      expect(added[0]?.body.thread_ts).toBeUndefined();
      expect(String(added[0]?.body.text)).toContain(`${s.ref} is waiting for a permission prompt`);
    });
  });

  describe("quiet", () => {
    it("posts one notice after 20 minutes without activity, then rests", async () => {
      const s = await launched({
        script: [
          { status: "running", items: ["Starting"] },
          { status: "running" },
          { status: "running" },
          { status: "running" },
        ],
      });
      clock = minutes(1);
      await checkJob(s.deps, s.job.id, 1000);
      const before = s.slack.posts().length;

      clock = minutes(15);
      await checkJob(s.deps, s.job.id, 1000);
      expect(s.slack.posts().length).toBe(before);

      clock = minutes(22);
      await checkJob(s.deps, s.job.id, 1000);
      const afterQuiet = s.slack.posts().slice(before);
      expect(afterQuiet).toHaveLength(1);
      expect(String(afterQuiet[0]?.body.text)).toContain(
        `${s.ref} has had no new activity for 21m. It is still running.`,
      );

      clock = minutes(25);
      await checkJob(s.deps, s.job.id, 1000);
      expect(s.slack.posts().slice(before)).toHaveLength(1);
    });
  });

  describe("ending a job", () => {
    it("interrupts the worker and posts one cancel line", async () => {
      const s = await launched({ script: [{ status: "running" }] });
      const before = s.slack.posts().length;

      await cancelJob(s.deps, s.job.id);
      await cancelJob(s.deps, s.job.id);

      expect(s.worker.interrupts).toHaveLength(1);
      expect(texts(s.slack.posts().slice(before))).toEqual([`${s.ref} was cancelled.`]);
    });

    it("hands a launched job to reconcile when its watcher fails", async () => {
      const s = await launched();
      const before = s.slack.posts().length;

      const status = await failJob(s.deps, s.job.id, "The task crashed");

      // The worker keeps running, so the job stays active with no watcher lease.
      expect(status).toBe("running");
      const job = await getJob(s.deps.sql, s.job.id);
      expect(job).toMatchObject({ status: "running", watchUntil: null });
      expect(s.slack.posts().slice(before)).toEqual([]);
    });

    it("posts one failure message for a job that failed before it launched", async () => {
      const s = await setup();
      await failJob(s.deps, s.job.id, "The task crashed");
      await failJob(s.deps, s.job.id, "The task crashed");

      expect((await getJob(s.deps.sql, s.job.id))?.status).toBe("failed");
      // It never posted a card or a brief here, so it posts nothing.
      expect(s.slack.posts()).toEqual([]);
    });

    it("posts nothing when it closes a job that never launched", async () => {
      const s = await setup();

      const closed = await closeUnlaunched(s.deps, s.job.id, "Owner rejected the brief");

      expect(closed.status).toBe("cancelled");
      expect(s.slack.calls).toEqual([]);
    });
  });

  it("gives every outbox row a display choice of level 1 or higher", async () => {
    const rows = await ledger.sql()<{ display: { level: number } | null }[]>`
      select display from outbox
    `;
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.display?.level).toBeGreaterThanOrEqual(1);
  });
});
