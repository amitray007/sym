import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Brief } from "../lib/jobs/brief.ts";
import { checkJob, launchOrAdopt } from "../lib/jobs/run.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { loadPack } from "../lib/pack/load.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// The fixture pack allows two projects: sync-service (worker project sync-service-main, base
// branch develop, draft PRs) and docs-site (base main, no PRs).
const pack = loadPack(join(import.meta.dirname, "fixtures/pack"));

const CALLBACK = "http://127.0.0.1:2000/.well-known/workflow/v1/webhook/abc";

const brief = (project: string, extra: Partial<Brief> = {}): Brief => ({
  project,
  title: "Retry",
  goal: "Add retry.",
  constraints: [],
  doneWhen: ["Tests pass"],
  openPullRequest: true,
  estimatedMinutes: 15,
  ...extra,
});

const projects = [
  { id: "p-sync", title: "sync-service-main", workspaceRoot: "/r/sync" },
  { id: "p-docs", title: "docs-site", workspaceRoot: "/r/docs" },
  { id: "p-other", title: "other-repo", workspaceRoot: "/r/other" },
];

describe.skipIf(!hasDatabase)("jobs under a pack", () => {
  const ledger = useLedger();
  let n = 0;

  async function launch(b: Brief) {
    const worker = new FakeWorker({ projects });
    const job = await createJob(ledger.sql(), {
      requestKey: `pack-${++n}`,
      kind: "code-change",
      title: b.title,
      brief: b,
      worker: "t3",
    });
    const launched = await launchOrAdopt({ sql: ledger.sql(), worker, pack }, job.id, CALLBACK);
    const request = worker.threads.get(launched.workerThreadId ?? "")?.request;
    return { worker, launched, request };
  }

  it("runs in the pack's worker project with its base branch and guardrails", async () => {
    const { launched, request } = await launch(brief("sync-service"));

    expect(launched.workerProjectId).toBe("p-sync");
    expect(request?.baseRef).toBe("develop");
    expect(request?.message).toContain("- Change only files that match: src/**, test/**.");
    expect(request?.message).toContain("Push the branch and open a draft pull request.");
    expect(request?.message).not.toContain("Keep production systems and customer data");
  });

  it("keeps the brief's no-push when the pack would allow a draft PR", async () => {
    const { request } = await launch(brief("sync-service", { openPullRequest: false }));
    expect(request?.message).toContain("Do not push and do not open a pull request.");
    expect(request?.message).not.toContain("open a draft pull request.");
  });

  it("refuses a pack project that runs on another worker", async () => {
    const worker = new FakeWorker({ projects });
    const job = await createJob(ledger.sql(), {
      requestKey: `pack-${++n}`,
      kind: "code-change",
      title: "Retry",
      brief: brief("sync-service"),
      worker: "t3",
    });
    await expect(
      launchOrAdopt({ sql: ledger.sql(), worker, pack, workerName: "server" }, job.id, CALLBACK),
    ).rejects.toThrow('runs on worker "laptop", but Sym is connected to "server"');
    expect(worker.launches).toBe(0);
  });

  it("keeps a base branch the brief names", async () => {
    const { request } = await launch(brief("sync-service", { baseRef: "release" }));
    expect(request?.baseRef).toBe("release");
  });

  it("turns a requested PR off when the project's policy allows none", async () => {
    const { request } = await launch(brief("docs-site"));

    expect(request?.baseRef).toBe("main");
    expect(request?.message).toContain("Do not push and do not open a pull request.");
    expect(request?.message).not.toContain("open a draft pull request");
  });

  it("refuses a project the pack does not list, even when the worker has it", async () => {
    await expect(launch(brief("other-repo"))).rejects.toThrow("is not one of Sym's projects");
  });

  it("adds rule breaks to the result message", async () => {
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
      sessionId: "pack-session",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.1",
      userId: "U1",
    });
    const final = `Done.\n\`\`\`json\n${JSON.stringify({
      summary: "Added retry",
      pr_url: null,
      tests: "ok",
      files_changed: ["src/sync.ts", "config/prod.yml"],
      open_questions: [],
    })}\n\`\`\``;
    const worker = new FakeWorker({ projects, script: [{ status: "completed", items: [final] }] });
    const job = await createJob(sql, {
      requestKey: "pack-concerns",
      sessionId: "pack-session",
      kind: "code-change",
      title: "Retry",
      brief: brief("sync-service"),
      worker: "t3",
      slackChannel: "C1",
      slackThreadTs: "1690000000.1",
    });
    // Midday in the pack's time zone: outside its quiet hours, so the result posts.
    const deps = { sql, worker, pack, slack, now: () => new Date("2026-10-20T10:00:00Z") };
    await launchOrAdopt(deps, job.id, CALLBACK);

    await checkJob(deps, job.id, 1000);

    const result = posts.find((text) => text.includes("Added retry"));
    expect(result).toContain("*⚠️ check before merge*");
    expect(result).toContain("changed files outside the allowed paths: config/prod.yml.");
  });
});
