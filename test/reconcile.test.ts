import { beforeEach, describe, expect, it } from "vitest";
import { deliver } from "../lib/delivery/deliver.ts";
import type { Brief } from "../lib/jobs/brief.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import { checkJob, type JobDeps, launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import { getJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import type { WorkerQuestion } from "../lib/workers/types.ts";
import { type FakeStep, FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

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
const CHANNEL = "C200";
const THREAD_TS = "1690000000.000200";
const SUMMARY = "Added retry with backoff";
const FINAL = `All set.\n\`\`\`json\n${JSON.stringify({
  summary: SUMMARY,
  pr_url: null,
  tests: "12 passed",
  files_changed: ["src/sync.ts"],
  open_questions: [],
})}\n\`\`\``;

const question = (requestId: string, prompt: string): WorkerQuestion => ({
  requestId,
  questions: [
    {
      id: "q1",
      prompt,
      options: [{ label: "Yes" }, { label: "No" }],
      multiSelect: false,
    },
  ],
});

// A worker that can lose its connection.
class FlakyWorker extends FakeWorker {
  down = false;

  override async wait(threadId: string, timeoutMs: number) {
    if (this.down) throw new Error("fake: worker unreachable");
    return super.wait(threadId, timeoutMs);
  }
}

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
    posts: () => calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body),
    updates: () => calls.filter((c) => c.method === "chat.update").map((c) => c.body),
  };
}

describe.skipIf(!hasDatabase)("reconcileJobs", () => {
  const ledger = useLedger();
  let n = 0;

  // Reconcile looks at every orphaned job in the schema, so each test starts with none.
  beforeEach(async () => {
    // Raw cleanup, not a real cancel: clear the channel so reconcile has no end post to recover.
    await ledger.sql()`update jobs set status = 'cancelled', finished_at = now(), slack_channel = null
      where status not in ('done', 'failed', 'cancelled')`;
  });

  async function setup(script: FakeStep[], options: { launch?: boolean } = {}) {
    const sql = ledger.sql();
    const id = ++n;
    const sessionId = `reconcile-session-${id}`;
    await recordSessionThread(sql, {
      sessionId,
      teamId: "T1",
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      userId: "U200",
    });
    const worker = new FlakyWorker({ script });
    const slack = fakeSlack();
    const deps: JobDeps = {
      sql,
      worker,
      allowedProjects: TEST_PROJECTS,
      slack: slack.api,
      now: () => new Date(),
    };
    let job = await startJob(sql, { requestKey: `reconcile-${id}`, sessionId, brief });
    if (options.launch !== false) job = await launchOrAdopt(deps, job.id, CALLBACK);
    // The post-launch card and start message are out of the way before the test looks at Slack.
    await deliver(sql, slack.api);
    const sent = slack.posts().length;
    const ref = `J-${job.id}`;
    return {
      sql,
      worker,
      deps,
      job,
      ref,
      send: () => deliver(sql, slack.api),
      newPosts: () => slack.posts().slice(sent),
      updates: slack.updates,
    };
  }

  const expireLease = (job: { id: number }) =>
    ledger.sql()`update jobs set watch_until = now() - interval '1 minute' where id = ${job.id}`;
  const textsOf = (posts: Record<string, unknown>[]) => posts.map((p) => String(p.text));

  it("takes over a job whose watcher lease ran out and finishes it", async () => {
    const s = await setup([{ status: "completed", items: [FINAL] }]);
    await expireLease(s.job);

    const report = await reconcileJobs(s.deps);
    await s.send();

    expect(report).toEqual({ checked: 1, finished: 1, offline: 0 });
    const done = await getJob(s.sql, s.job.id);
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.card?.text).toMatch(
      new RegExp(`^\\[${s.ref}\\] Billing sync retry · Done in \\ds$`),
    );
    const results = s.newPosts().filter((p) => String(p.text).includes(SUMMARY));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
  });

  it("finishes a job left in checking with the rule checks alone", async () => {
    const s = await setup([{ status: "completed", items: [FINAL] }]);
    // The task moved the job to checking, then stopped before the model check finished.
    expect((await checkJob(s.deps, s.job.id, 1000, { verify: true })).status).toBe("checking");
    await s.send();
    expect(s.newPosts()).toEqual([]);
    await expireLease(s.job);

    const report = await reconcileJobs(s.deps);
    await reconcileJobs(s.deps);
    await s.send();

    expect(report).toEqual({ checked: 1, finished: 1, offline: 0 });
    expect((await getJob(s.sql, s.job.id))?.status).toBe("done");
    const posts = textsOf(s.newPosts());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(SUMMARY);
    expect(posts[0]).not.toContain("verifier");
    expect(posts[0]).not.toContain("Model check");
  });

  it("does not touch a job with a live lease", async () => {
    const s = await setup([{ status: "completed", items: [FINAL] }]);
    const before = await getJob(s.sql, s.job.id);

    const report = await reconcileJobs(s.deps);
    await s.send();

    expect(report).toEqual({ checked: 0, finished: 0, offline: 0 });
    expect((await getJob(s.sql, s.job.id))?.status).toBe("running");
    expect((await getJob(s.sql, s.job.id))?.updatedAt).toEqual(before?.updatedAt);
    expect(s.newPosts()).toEqual([]);
  });

  it("ignores a job without a worker thread", async () => {
    const s = await setup([{ status: "completed", items: [FINAL] }], { launch: false });

    const report = await reconcileJobs(s.deps);

    expect(report).toEqual({ checked: 0, finished: 0, offline: 0 });
    expect((await getJob(s.sql, s.job.id))?.status).toBe("launching");
    expect(s.worker.launches).toBe(0);
  });

  it("marks an unreachable worker offline, posts once, and edits that post when it is back", async () => {
    const s = await setup([{ status: "running", items: ["Working"] }]);
    await expireLease(s.job);
    s.worker.down = true;

    const first = await reconcileJobs(s.deps);
    await s.send();
    expect(first).toEqual({ checked: 0, finished: 0, offline: 1 });
    expect(await getJob(s.sql, s.job.id)).toMatchObject({
      status: "worker_offline",
      lastSummary: "The worker is unreachable",
    });
    expect(textsOf(s.newPosts())).toEqual([
      `${s.ref}: the worker is unreachable. Sym keeps checking and posts when it is back.`,
    ]);

    const second = await reconcileJobs(s.deps);
    await s.send();
    expect(second).toEqual({ checked: 0, finished: 0, offline: 1 });
    expect(s.newPosts()).toHaveLength(1);

    s.worker.down = false;
    const third = await reconcileJobs(s.deps);
    await s.send();
    expect(third.checked).toBe(1);
    expect(third.offline).toBe(0);
    // Back is a silent edit of the outage notice, not a new message.
    expect(s.newPosts()).toHaveLength(1);
    const backEdits = s.updates().filter((u) => String(u.text).includes("The worker is back"));
    expect(backEdits).toHaveLength(1);
    expect(backEdits[0]).toMatchObject({ channel: CHANNEL });
    expect((await getJob(s.sql, s.job.id))?.status).toBe("running");
  });

  it("drops an outage notice that never went out when the worker comes back", async () => {
    const s = await setup([{ status: "running", items: ["Working"] }]);
    await expireLease(s.job);
    s.worker.down = true;
    await reconcileJobs(s.deps);

    s.worker.down = false;
    await reconcileJobs(s.deps);
    await s.send();

    expect(s.newPosts()).toEqual([]);
    expect(s.updates().filter((u) => String(u.text).includes("worker"))).toEqual([]);
  });

  it("tells the thread once per worker question", async () => {
    const s = await setup([
      {
        status: "waiting",
        questions: [
          question("req-a", "Use exponential backoff?"),
          question("req-b", "Add jitter?"),
        ],
      },
    ]);
    await expireLease(s.job);

    await reconcileJobs(s.deps);
    await s.send();
    const asked = () => textsOf(s.newPosts()).filter((t) => t.includes("has a question"));
    expect(asked()).toHaveLength(2);
    expect(asked().join("\n")).toContain("Use exponential backoff?");
    expect(asked().join("\n")).toContain("Add jitter?");
    expect(asked()[0]).toContain(`${s.ref} has a question on the worker`);
    expect(asked()[0]).toContain(String((await getJob(s.sql, s.job.id))?.workerThreadId));
    expect((await getJob(s.sql, s.job.id))?.status).toBe("waiting_input");

    await expireLease(s.job);
    await reconcileJobs(s.deps);
    await s.send();
    expect(asked()).toHaveLength(2);
  });
});
