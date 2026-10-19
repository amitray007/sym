import { describe, expect, it } from "vitest";
import { deliver } from "../lib/delivery/deliver.ts";
import type { Brief } from "../lib/jobs/brief.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import { checkJob, launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

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

  it("watches a finished job's PR once and posts each wake once", async () => {
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
    const deps = { sql, worker, slack };
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
    expect(wakes).toEqual([
      `J-${job.id}: <${PR}|PR #12>: checks failed. The worker is looking into it.`,
    ]);
  });
});
