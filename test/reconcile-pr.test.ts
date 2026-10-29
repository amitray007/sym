import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver } from "../lib/delivery/deliver.ts";
import type { Brief } from "../lib/jobs/brief.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import { checkJob, launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const PR = "https://github.com/example/app/pull/12";
const FINAL = `Done.\n\`\`\`json\n${JSON.stringify({
  summary: "Added retry",
  pr_url: PR,
  tests: "ok",
  files_changed: ["src/a.ts"],
  open_questions: [],
})}\n\`\`\``;

const brief: Brief = {
  project: "test-repo",
  title: "Retry",
  goal: "Add retry.",
  constraints: [],
  doneWhen: ["Tests pass"],
  openPullRequest: true,
  estimatedMinutes: 15,
};

describe.skipIf(!hasDatabase)("reconcile follows pull requests", () => {
  const ledger = useLedger();
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not watch a PR without SYM_PR_FOLLOW=on", async () => {
    const sql = ledger.sql();
    const worker = new FakeWorker({ script: [{ status: "completed", items: [FINAL] }] });
    const deps = { sql, worker, allowedProjects: TEST_PROJECTS };
    const job = await startJob(sql, { requestKey: "pr-off", sessionId: "pr-off", brief });
    await launchOrAdopt(deps, job.id, "http://127.0.0.1/cb");
    await checkJob(deps, job.id, 1000);

    vi.stubEnv("SYM_PR_FOLLOW", "");
    await reconcileJobs(deps);
    expect(worker.watches).toEqual([]);
  });

  it("watches a finished job's PR once and posts each wake once", async () => {
    vi.stubEnv("SYM_PR_FOLLOW", "on");
    const sql = ledger.sql();
    const posts: string[] = [];
    let ts = 1;
    const slack: SlackApi = {
      async call(method, body) {
        if (method === "chat.postMessage") posts.push(String(body.text));
        return { ok: true, ts: `1700000000.${ts++}` };
      },
    };
    await recordSessionThread(sql, {
      sessionId: "pr-session",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.1",
      userId: "U1",
    });
    const worker = new FakeWorker({ script: [{ status: "completed", items: [FINAL] }] });
    const deps = { sql, worker, allowedProjects: TEST_PROJECTS, slack };
    const job = await startJob(sql, { requestKey: "pr-job", sessionId: "pr-session", brief });
    const launched = await launchOrAdopt(deps, job.id, "http://127.0.0.1/cb");
    await checkJob(deps, job.id, 1000);

    await reconcileJobs(deps);
    await reconcileJobs(deps);
    expect(worker.watches).toEqual([
      { threadId: launched.workerThreadId, prUrl: PR, requestId: `J-${job.id}:watch` },
    ]);

    worker.addWake(launched.workerThreadId ?? "", "#12: checks failed");
    const before = posts.length;
    await reconcileJobs(deps);
    await reconcileJobs(deps);
    await deliver(sql, slack);

    const wakes = posts.slice(before).filter((text) => text.includes("checks failed"));
    expect(wakes).toEqual([`J-${job.id}: <${PR}|PR #12>: checks failed.`]);
  });
});

describe.skipIf(!hasDatabase)("reconcile recovers a lost end post", () => {
  const ledger = useLedger();

  it("posts the result of a job that ended without one", async () => {
    const sql = ledger.sql();
    const posts: string[] = [];
    let ts = 1;
    const slack: SlackApi = {
      async call(method, body) {
        if (method === "chat.postMessage") posts.push(String(body.text));
        return { ok: true, ts: `1700000000.${ts++}` };
      },
    };
    await recordSessionThread(sql, {
      sessionId: "lost-end",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.2",
      userId: "U1",
    });
    const worker = new FakeWorker({ script: [{ status: "running" }] });
    const deps = { sql, worker, allowedProjects: TEST_PROJECTS, slack };
    const job = await startJob(sql, { requestKey: "lost-end", sessionId: "lost-end", brief });
    await launchOrAdopt(deps, job.id, "http://127.0.0.1/cb");
    // A crash after the status moved to done, before the end post was queued.
    await sql`update jobs set status = 'done', finished_at = now(), last_message = ${FINAL}
      where id = ${job.id}`;

    await reconcileJobs(deps);
    await reconcileJobs(deps);
    await deliver(sql, slack);

    expect(posts.filter((text) => text.includes("Added retry"))).toHaveLength(1);
  });
});

describe.skipIf(!hasDatabase)("end presentation marks", () => {
  const ledger = useLedger();

  async function endedJob(key: string, extra: Record<string, unknown> = {}) {
    const sql = ledger.sql();
    await recordSessionThread(sql, {
      sessionId: key,
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.3",
      userId: "U1",
    });
    const worker = new FakeWorker({ script: [{ status: "running" }] });
    const job = await startJob(sql, { requestKey: key, sessionId: key, brief });
    await launchOrAdopt(
      { sql, worker, allowedProjects: TEST_PROJECTS },
      job.id,
      "http://127.0.0.1/cb",
    );
    await sql`update jobs set status = 'done', finished_at = now(), last_message = ${FINAL},
      kind = ${String(extra.kind ?? "code-change")}, verdict = ${sql.json(
        (extra.verdict ?? null) as never,
      )}
      where id = ${job.id}`;
    return { sql, worker, job };
  }

  it("marks a silent scheduled check as presented, so recovery skips it", async () => {
    const { sql, worker, job } = await endedJob("silent-check", { kind: "scheduled-check" });
    const clean = FINAL.replace(PR, "");
    await sql`update jobs set last_message = ${clean.replace('"pr_url":""', '"pr_url":null')}
      where id = ${job.id}`;

    await reconcileJobs({ sql, worker });

    const [row] = await sql`select end_presented_at from jobs where id = ${job.id}`;
    expect(row?.endPresentedAt).toBeInstanceOf(Date);
  });

  it("posts the stored verdict when it recovers an end post", async () => {
    const posts: string[] = [];
    let ts = 1;
    const slack: SlackApi = {
      async call(method, body) {
        if (method === "chat.postMessage") posts.push(String(body.text));
        return { ok: true, ts: `1700000000.${ts++}` };
      },
    };
    const verdict = {
      status: "checked",
      output: { verdict: "concerns", concerns: ["The retry has no upper bound."], confidence: 0.7 },
    };
    const { sql, worker } = await endedJob("stored-verdict", { verdict });

    await reconcileJobs({ sql, worker, allowedProjects: TEST_PROJECTS, slack });
    await deliver(sql, slack);

    const result = posts.find((text) => text.includes("Added retry"));
    expect(result).toContain("The retry has no upper bound.");
  });
});
