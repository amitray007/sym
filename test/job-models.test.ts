import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Brief } from "../lib/jobs/brief.ts";
import { launchOrAdopt, showBrief } from "../lib/jobs/run.ts";
import { createJob, getJob } from "../lib/ledger/jobs.ts";
import { loadPack } from "../lib/pack/load.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const CALLBACK = "http://127.0.0.1:2000/.well-known/workflow/v1/webhook/abc";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function pack(project: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sym-job-models-"));
  dirs.push(dir);
  const manifest = {
    owner: { slackUserId: "U0OWNER01" },
    workers: [
      {
        name: "mac",
        kind: "t3",
        mcpUrl: "https://mac.example.ts.net/mcp",
        models: [
          { id: "claudeAgent/claude-sonnet-5-5", use: "Routine changes", effort: "medium" },
          { id: "codex/gpt-6-luna", use: "Checks", effort: "low", default: true },
        ],
      },
    ],
    projects: [{ name: "test-repo", worker: "mac", allowedPaths: ["src/**"], ...project }],
  };
  writeFileSync(join(dir, "sym.config.yaml"), JSON.stringify(manifest));
  return loadPack(dir);
}

const brief = (extra: Partial<Brief> = {}): Brief => ({
  project: "test-repo",
  title: "Retry",
  goal: "Add retry.",
  constraints: [],
  doneWhen: ["Tests pass"],
  openPullRequest: false,
  estimatedMinutes: 15,
  ...extra,
});

describe.skipIf(!hasDatabase)("worker model at launch", () => {
  const ledger = useLedger();
  let n = 0;

  async function launch(b: Brief, deps: Record<string, unknown> = {}, worker = new FakeWorker()) {
    const job = await createJob(ledger.sql(), {
      requestKey: `model-${++n}`,
      kind: "code-change",
      title: b.title,
      brief: b,
      worker: "t3",
    });
    const launched = await launchOrAdopt(
      { sql: ledger.sql(), worker, allowedProjects: TEST_PROJECTS, ...deps },
      job.id,
      CALLBACK,
    );
    const request = worker.threads.get(launched.workerThreadId ?? "")?.request;
    return { launched, request, job: await getJob(ledger.sql(), job.id) };
  }

  it("launches the built-in default with its effort and records it on the job", async () => {
    const { request, job } = await launch(brief());
    expect(request?.model).toEqual({
      providerId: "claudeAgent",
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "medium" }],
    });
    expect(job?.workerModel).toBe("claudeAgent/claude-sonnet-5-5");
  });

  it("launches the brief's model when it is on the list", async () => {
    const { request, job } = await launch(brief({ model: "codex/gpt-6.1-sol" }));
    expect(request?.model).toEqual({
      providerId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(job?.workerModel).toBe("codex/gpt-6.1-sol");
  });

  it("makes SYM_WORKER_MODEL the default", async () => {
    const workerModel = { providerId: "fake", model: "fake-model" };
    const { request, job } = await launch(brief(), { workerModel });
    expect(request?.model).toEqual({ providerId: "fake", model: "fake-model" });
    expect(job?.workerModel).toBe("fake/fake-model");
  });

  it("uses the pack's list default", async () => {
    const { request } = await launch(brief(), { pack: pack() });
    expect(request?.model?.model).toBe("gpt-6-luna");
  });

  it("lets the pack project's model win over the brief's", async () => {
    const { request } = await launch(brief({ model: "codex/gpt-6-luna" }), {
      pack: pack({ model: "claudeAgent/claude-sonnet-5-5" }),
    });
    expect(request?.model?.model).toBe("claude-sonnet-5-5");
  });

  it("replaces an off-list brief model with the default and tells the owner", async () => {
    const { request, job } = await launch(brief({ model: "claudeAgent/made-up" }));
    expect(request?.model?.model).toBe("claude-sonnet-5-5");
    expect(job?.lastSummary).toContain("not on the list");
  });

  it("falls back to an available listed model and says so", async () => {
    const worker = new FakeWorker({
      capabilities: {
        providers: [
          { id: "codex", name: "Codex", models: ["gpt-6-luna"], available: true },
          { id: "claudeAgent", name: "Claude", models: ["claude-sonnet-5-5"], available: false },
        ],
      },
    });
    const { request, job } = await launch(brief(), {}, worker);
    expect(request?.model).toEqual({ providerId: "codex", model: "gpt-6-luna" });
    expect(job?.lastSummary).toContain("is not available");
    expect(job?.workerModel).toBe("codex/gpt-6-luna");
  });

  it("launches without a model when no listed model is available", async () => {
    const worker = new FakeWorker({ capabilities: { providers: [] } });
    const { request, job } = await launch(brief(), {}, worker);
    expect(request?.model).toBeUndefined();
    expect(job?.workerModel).toBeNull();
    expect(job?.lastSummary).toContain("project default");
  });
});

describe.skipIf(!hasDatabase)("the brief's model line", () => {
  const ledger = useLedger();

  async function posted(b: Brief, deps: Record<string, unknown> = {}) {
    const job = await createJob(ledger.sql(), {
      requestKey: `line-${b.title}-${Math.random()}`,
      kind: "code-change",
      title: b.title,
      brief: b,
      worker: "t3",
      slackChannel: "C0TEST001",
    });
    await showBrief({ sql: ledger.sql(), ...deps }, job.id);
    const [row] = await ledger.sql()<{ payload: { text: string } }[]>`
      select payload from outbox where job_id = ${job.id}`;
    return row?.payload.text ?? "";
  }

  it("shows the default the job will use", async () => {
    expect(await posted(brief())).toContain("Model: claude-sonnet-5-5 (medium) · default");
  });

  it("shows the brief's model and reason", async () => {
    const text = await posted(
      brief({ model: "claudeAgent/claude-opus-5-5", modelReason: "touches migrations" }),
    );
    expect(text).toContain("Model: claude-opus-5-5 (high) · touches migrations");
  });

  it("shows the pack project's model", async () => {
    const text = await posted(brief(), { pack: pack({ model: "claudeAgent/claude-sonnet-5-5" }) });
    expect(text).toContain("Model: claude-sonnet-5-5 (medium) · set for this project");
  });
});
