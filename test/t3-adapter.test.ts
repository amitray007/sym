import { describe, expect, it } from "vitest";
import { type CallTool, t3Adapter, toWorkerStatus } from "../lib/workers/t3/adapter.ts";

// A fake worker: records calls and answers from a table, so tests never reach a real T3.
function fakeT3(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { name: string; args: Record<string, unknown>; options?: unknown }[] = [];
  const call: CallTool = async (name, args, options) => {
    calls.push({ name, args, options });
    const answer = answers[name];
    if (!answer) throw new Error(`unexpected tool ${name}`);
    return answer(args);
  };
  return { call, calls };
}

const project = (id: string, deletedAt: string | null = null) => ({
  id,
  title: `Project ${id}`,
  workspaceRoot: `/repos/${id}`,
  scripts: [],
  deletedAt,
});

describe("t3Adapter.capabilities", () => {
  it("maps providers and marks constrained ones unavailable", async () => {
    const { call } = fakeT3({
      orchestrator_capabilities: () => ({
        parentThreadId: null,
        providers: [
          {
            providerInstanceId: "codex",
            driverKind: "codex",
            displayName: "Codex",
            models: [{ id: "model-a", label: "Model A", options: [] }],
            constraints: [],
          },
          {
            providerInstanceId: "other",
            driverKind: "other",
            displayName: "Other",
            models: [],
            constraints: ["Provider instance is disabled."],
          },
        ],
        features: { threadManagement: true },
      }),
    });

    expect(await t3Adapter(call).capabilities()).toEqual({
      providers: [
        { id: "codex", name: "Codex", models: ["model-a"], available: true },
        { id: "other", name: "Other", models: [], available: false },
      ],
    });
  });

  it("rejects a result without providers", async () => {
    const { call } = fakeT3({ orchestrator_capabilities: () => ({ features: {} }) });
    await expect(t3Adapter(call).capabilities()).rejects.toThrow();
  });
});

describe("t3Adapter.projects", () => {
  it("follows the cursor and skips deleted projects", async () => {
    const { call, calls } = fakeT3({
      t3_project_list: (args) =>
        args.cursor === undefined
          ? { projects: [project("a"), project("b", "2026-10-01T00:00:00.000Z")], nextCursor: 2 }
          : { projects: [project("c")], nextCursor: null },
    });

    const projects = await t3Adapter(call).projects();

    expect(projects).toEqual([
      { id: "a", title: "Project a", workspaceRoot: "/repos/a" },
      { id: "c", title: "Project c", workspaceRoot: "/repos/c" },
    ]);
    expect(calls.map((c) => c.args)).toEqual([{ limit: 100 }, { limit: 100, cursor: 2 }]);
  });

  it("stops when the worker never ends the cursor", async () => {
    const { call } = fakeT3({ t3_project_list: () => ({ projects: [], nextCursor: 1 }) });
    await expect(t3Adapter(call).projects()).rejects.toThrow("more than 50 pages");
  });
});

describe("toWorkerStatus", () => {
  it.each([
    ["preparing", "running"],
    ["running", "running"],
    ["waiting", "waiting"],
    ["completed", "completed"],
    ["rolled_back", "failed"],
    ["cancelled", "interrupted"],
    ["idle", "unknown"],
    ["something-new", "unknown"],
  ])("maps %s to %s", (t3Status, expected) => {
    expect(toWorkerStatus(t3Status)).toBe(expected);
  });
});

describe("t3Adapter.findByTitle", () => {
  it("returns the thread whose title holds the job reference", async () => {
    const { call, calls } = fakeT3({
      t3_thread_list: () => ({
        threads: [{ threadId: "t-1", title: "[J-7] Retry", status: "running", model: "m" }],
        nextCursor: null,
      }),
    });

    expect(await t3Adapter(call).findByTitle("p-1", "[J-7]")).toEqual({
      id: "t-1",
      title: "[J-7] Retry",
      status: "running",
    });
    expect(calls[0]?.args).toEqual({ projectId: "p-1", titleContains: "[J-7]", limit: 10 });
  });

  it("matches the title prefix, not a job reference later in the title", async () => {
    const { call } = fakeT3({
      t3_thread_list: () => ({
        threads: [{ threadId: "t-3", title: "[J-3] fix [J-9] x", status: "running" }],
        nextCursor: null,
      }),
    });
    expect(await t3Adapter(call).findByTitle("p-1", "[J-9]")).toBeUndefined();
  });

  it("returns nothing when no title matches", async () => {
    const { call } = fakeT3({ t3_thread_list: () => ({ threads: [], nextCursor: null }) });
    expect(await t3Adapter(call).findByTitle("p-1", "[J-8]")).toBeUndefined();
  });
});

describe("t3Adapter.launch", () => {
  it("starts the thread in a new worktree from origin", async () => {
    const { call, calls } = fakeT3({
      t3_thread_launch: () => ({
        threadId: "t-9",
        projectId: "p-1",
        runId: "r-1",
        status: "preparing",
      }),
    });

    const thread = await t3Adapter(call).launch({
      projectId: "p-1",
      title: "[J-9] Retry",
      message: "brief",
      baseRef: "main",
      model: { providerId: "codex", model: "model-a" },
    });

    expect(thread).toEqual({ id: "t-9", title: "[J-9] Retry", status: "running" });
    expect(calls[0]?.args).toEqual({
      projectId: "p-1",
      title: "[J-9] Retry",
      message: "brief",
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
      modelSelection: { instanceId: "codex", model: "model-a" },
    });
  });
});

describe("t3Adapter.readActivity", () => {
  const read = (nextPosition: number | null) => () => ({
    thread: { threadId: "t-1", status: "waiting", pendingRequestCount: 1 },
    items: [{ position: 4, type: "assistant_message", text: "Tests failed", itemId: "i" }],
    nextPosition,
    hasMore: false,
  });

  it("reads after the cursor and returns the next cursor", async () => {
    const { call, calls } = fakeT3({ t3_thread_read: read(4) });

    const activity = await t3Adapter(call).readActivity("t-1", "3");

    expect(activity).toEqual({
      status: "waiting",
      items: [{ position: 4, type: "assistant_message", text: "Tests failed" }],
      cursor: "4",
      pendingRequests: 1,
      hasMore: false,
    });
    expect(calls[0]?.args).toMatchObject({ threadId: "t-1", view: "activity", afterPosition: 3 });
  });

  it("keeps the old cursor when the worker returns none", async () => {
    const { call } = fakeT3({ t3_thread_read: read(null) });
    expect((await t3Adapter(call).readActivity("t-1", "3")).cursor).toBe("3");
  });
});

describe("t3Adapter.wait", () => {
  it("gives the MCP request more time than the worker wait", async () => {
    const { call, calls } = fakeT3({
      t3_thread_wait: () => ({ threadId: "t-1", runId: "r-1", status: "running", timedOut: true }),
    });

    expect(await t3Adapter(call).wait("t-1", 60_000)).toEqual({
      status: "running",
      timedOut: true,
    });
    expect(calls[0]?.args).toEqual({ threadId: "t-1", timeoutMs: 60_000 });
    expect(calls[0]?.options).toEqual({ timeoutMs: 75_000 });
  });
});

describe("t3Adapter.interrupt", () => {
  it("passes the request ID so a retry is safe", async () => {
    const { call, calls } = fakeT3({ t3_thread_interrupt: () => ({ interrupted: true }) });

    await t3Adapter(call).interrupt("t-1", "Cancelled in Sym", "cancel-J-1");

    expect(calls[0]?.args).toEqual({
      threadId: "t-1",
      reason: "Cancelled in Sym",
      clientRequestId: "cancel-J-1",
    });
  });
});
