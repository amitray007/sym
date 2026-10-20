import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Brief } from "../lib/jobs/brief.ts";
import { launchOrAdopt } from "../lib/jobs/run.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { loadPack } from "../lib/pack/load.ts";
import {
  allowedProjects,
  checkProject,
  findAllowedProject,
  projectInstructions,
  projectRefusal,
  projectRows,
} from "../lib/projects/allowed.ts";
import { isSlackUserAllowed, sayPrivately } from "../lib/slack/guard.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const pack = loadPack(join(import.meta.dirname, "fixtures/pack"));
const CALLBACK = "http://127.0.0.1:2000/.well-known/workflow/v1/webhook/abc";

// The worker has far more projects than Sym may touch.
const workerProjects = [
  { id: "p-1", title: "alpha", workspaceRoot: "/r/alpha" },
  { id: "p-2", title: "beta", workspaceRoot: "/r/beta" },
  { id: "p-3", title: "secret-one", workspaceRoot: "/r/s1" },
  { id: "p-4", title: "secret-two", workspaceRoot: "/r/s2" },
];

describe("allowedProjects", () => {
  it("uses the pack's projects when a pack is loaded, and ignores the env list", () => {
    const list = allowedProjects(pack, "ignored");
    expect(list.map((p) => p.name)).toEqual(["sync-service", "docs-site"]);
    expect(list[0]?.workerProject).toBe("sync-service-main");
    expect(list[1]?.workerProject).toBe("docs-site");
  });

  it("reads SYM_PROJECTS without a pack: trimmed, deduplicated, no blanks", () => {
    expect(allowedProjects(undefined, " alpha, p-2 ,,ALPHA,beta ").map((p) => p.name)).toEqual([
      "alpha",
      "p-2",
      "beta",
    ]);
  });

  it("allows nothing with neither a pack nor SYM_PROJECTS", () => {
    expect(allowedProjects(undefined, undefined)).toEqual([]);
    expect(allowedProjects(undefined, "  ")).toEqual([]);
    expect(checkProject([], "alpha")).toContain("Sym has no projects configured.");
  });

  it("matches an exact ID or a case-insensitive exact title", () => {
    const list = allowedProjects(undefined, "alpha,p-2");
    expect(findAllowedProject(list, "ALPHA")?.name).toBe("alpha");
    expect(findAllowedProject(list, "p-2")?.name).toBe("p-2");
    expect(findAllowedProject(list, "P-2")?.name).toBe("p-2");
    expect(findAllowedProject(list, "alph")).toBeUndefined();
    expect(findAllowedProject(list, "beta")).toBeUndefined();
  });
});

describe("refusal wording", () => {
  const list = allowedProjects(undefined, "alpha,beta");

  it("names only the allowed projects and has one shape for any other project", () => {
    expect(projectRefusal(list, "secret-one")).toBe(
      `"secret-one" is not one of Sym's projects. Sym works on: alpha, beta.`,
    );
    // Same sentence whether the project exists on the worker (secret-one) or not (nowhere).
    expect(projectRefusal(list, "nowhere").replace("nowhere", "X")).toBe(
      projectRefusal(list, "secret-one").replace("secret-one", "X"),
    );
  });
});

describe("projectInstructions", () => {
  it("lists only the allowed names", () => {
    const text = projectInstructions(allowedProjects(undefined, "alpha,beta"));
    expect(text).toContain("- alpha");
    expect(text).toContain("- beta");
    expect(text).not.toContain("secret");
  });

  it("says no project is configured when the list is empty", () => {
    expect(projectInstructions([])).toContain("no projects configured");
  });
});

describe("projectRows", () => {
  const list = allowedProjects(undefined, "alpha,missing,p-2");

  it("never returns a project outside the list, even when the worker has many", () => {
    const rows = projectRows(list, workerProjects);
    expect(rows).toEqual([
      { name: "alpha", title: "alpha", worker: "present" },
      { name: "missing", title: "missing", worker: "missing" },
      { name: "p-2", title: "beta", worker: "present" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("gives an unknown state when the worker cannot be asked", () => {
    expect(projectRows(list, undefined).map((row) => row.worker)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
  });
});

const brief = (project: string): Brief => ({
  project,
  title: "Retry",
  goal: "Add retry.",
  constraints: [],
  doneWhen: ["Tests pass"],
  openPullRequest: false,
  estimatedMinutes: 15,
});

describe.skipIf(!hasDatabase)("launch refusal", () => {
  const ledger = useLedger();
  let n = 0;

  async function tryLaunch(project: string, deps: Record<string, unknown>) {
    const worker = new FakeWorker({ projects: workerProjects });
    const job = await createJob(ledger.sql(), {
      requestKey: `allow-${++n}`,
      kind: "code-change",
      title: "Retry",
      brief: brief(project),
      worker: "t3",
    });
    const result = await launchOrAdopt({ sql: ledger.sql(), worker, ...deps }, job.id, CALLBACK)
      .then(() => "")
      .catch((error: Error) => error.message);
    return { worker, message: result };
  }

  it("refuses a stored brief for a project outside the list, with the same words", async () => {
    const allowedProjects_ = allowedProjects(undefined, "alpha,beta");
    const exists = await tryLaunch("secret-one", { allowedProjects: allowedProjects_ });
    const absent = await tryLaunch("nowhere", { allowedProjects: allowedProjects_ });

    expect(exists.worker.launches).toBe(0);
    expect(absent.worker.launches).toBe(0);
    expect(exists.message).toBe(
      `"secret-one" is not one of Sym's projects. Sym works on: alpha, beta.`,
    );
    expect(exists.message.replace("secret-one", "X")).toBe(absent.message.replace("nowhere", "X"));
  });

  it("fails closed with no list and no pack", async () => {
    const { worker, message } = await tryLaunch("alpha", {});
    expect(worker.launches).toBe(0);
    expect(message).toContain("Sym has no projects configured.");
  });

  it("launches an allowed project by title or ID", async () => {
    const list = allowedProjects(undefined, "alpha,p-2");
    expect((await tryLaunch("alpha", { allowedProjects: list })).worker.launches).toBe(1);
    expect((await tryLaunch("p-2", { allowedProjects: list })).worker.launches).toBe(1);
  });

  it("refuses a pack project that left the list", async () => {
    const { worker, message } = await tryLaunch("other-repo", { pack });
    expect(worker.launches).toBe(0);
    expect(message).toContain(
      "is not one of Sym's projects. Sym works on: sync-service, docs-site.",
    );
  });
});

describe("Slack allow-list logging", () => {
  it("logs the Slack user ID only when it drops a request", () => {
    const warn = vi.fn();
    expect(isSlackUserAllowed(undefined, "UOWNER", "UOTHER", warn)).toBe(false);
    expect(isSlackUserAllowed(undefined, "UOWNER", "UOWNER", warn)).toBe(true);
    expect(isSlackUserAllowed(undefined, "UOWNER", undefined, warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("UOTHER");
  });

  it("logs Slack's error code, never the message text", async () => {
    const warn = vi.fn();
    const where = { channel: "C1", user: "U1" };
    await sayPrivately(
      { request: async () => ({ ok: false, error: "channel_not_found" }) },
      where,
      "private text",
      warn,
    );
    await sayPrivately(
      {
        request: async () => {
          throw new Error("failed with private text");
        },
      },
      where,
      "private text",
      warn,
    );
    expect(warn.mock.calls[0]?.[0]).toContain("channel_not_found");
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain("private text");
  });
});
