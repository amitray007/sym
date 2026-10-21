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
            models: [
              {
                id: "model-a",
                label: "Model A",
                options: [
                  {
                    id: "reasoningEffort",
                    label: "Effort",
                    type: "select",
                    options: [
                      { id: "low", label: "Low" },
                      { id: "high", label: "High" },
                    ],
                    currentValue: "low",
                  },
                  { id: "fast", label: "Fast", type: "boolean" },
                ],
              },
            ],
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
        {
          id: "codex",
          name: "Codex",
          models: ["model-a"],
          modelOptions: { "model-a": [{ id: "reasoningEffort", values: ["low", "high"] }] },
          available: true,
        },
        { id: "other", name: "Other", models: [], modelOptions: {}, available: false },
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
      model: {
        providerId: "codex",
        model: "model-a",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    });

    expect(thread).toEqual({ id: "t-9", title: "[J-9] Retry", status: "running" });
    expect(calls[0]?.args).toEqual({
      projectId: "p-1",
      title: "[J-9] Retry",
      message: "brief",
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
      modelSelection: {
        instanceId: "codex",
        model: "model-a",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
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

  it("marks a cut item with where its text goes on", async () => {
    const { call } = fakeT3({
      t3_thread_read: () => ({
        thread: { threadId: "t-1", status: "completed", pendingRequestCount: 0 },
        items: [
          {
            position: 1,
            type: "assistant_message",
            text: "a",
            itemId: "i-1",
            textTruncated: true,
            nextTextOffset: 1,
          },
        ],
        nextPosition: 1,
        hasMore: false,
      }),
    });
    const activity = await t3Adapter(call).readActivity("t-1", null);
    expect(activity.items[0]).toEqual({
      position: 1,
      type: "assistant_message",
      text: "a",
      rest: { itemId: "i-1", offset: 1 },
    });
  });

  it("reads the rest in pieces and stops on a piece that does not move on", async () => {
    const pieces: Record<number, { text: string; nextTextOffset: number | null }> = {
      1: { text: "bb", nextTextOffset: 3 },
      3: { text: "cc", nextTextOffset: 5 },
      5: { text: "dd", nextTextOffset: null },
    };
    const { call, calls } = fakeT3({
      t3_thread_read: (args) => ({ items: [pieces[args.textOffset as number]] }),
    });
    expect(await t3Adapter(call).readRest?.("t-1", "i-1", 1)).toBe("bbccdd");
    expect(calls[0]?.args).toEqual({
      threadId: "t-1",
      view: "activity",
      itemId: "i-1",
      textOffset: 1,
      maxCharsPerItem: 50_000,
    });

    const stuck = fakeT3({
      t3_thread_read: (args) => ({ items: [{ text: "x", nextTextOffset: args.textOffset }] }),
    });
    expect(await t3Adapter(stuck.call).readRest?.("t-1", "i-1", 1)).toBe("");
    expect(stuck.calls).toHaveLength(1);
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

describe("t3Adapter.pendingQuestions", () => {
  it("reads each pending request and maps its questions", async () => {
    const { call, calls } = fakeT3({
      t3_pending_request_list: () => ({ requestIds: ["req-1", "req-2"] }),
      t3_pending_request_read: (args) =>
        args.requestId === "req-1"
          ? {
              requestId: "req-1",
              questions: [
                {
                  id: "q-env",
                  header: "Target",
                  question: "Which environment?",
                  options: [
                    { label: "staging", description: "Safe", value: "s" },
                    { label: "production", description: "" },
                  ],
                  multiSelect: true,
                  allowCustomAnswer: true,
                },
              ],
            }
          : {
              requestId: "req-2",
              questions: [{ id: "q-name", header: "", question: "Name?", options: [] }],
            },
    });

    expect(await t3Adapter(call).pendingQuestions("t-1")).toEqual([
      {
        requestId: "req-1",
        questions: [
          {
            id: "q-env",
            header: "Target",
            prompt: "Which environment?",
            options: [{ label: "staging", description: "Safe" }, { label: "production" }],
            multiSelect: true,
          },
        ],
      },
      {
        requestId: "req-2",
        questions: [{ id: "q-name", prompt: "Name?", options: [], multiSelect: false }],
      },
    ]);
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ["t3_pending_request_list", { threadId: "t-1" }],
      ["t3_pending_request_read", { threadId: "t-1", requestId: "req-1" }],
      ["t3_pending_request_read", { threadId: "t-1", requestId: "req-2" }],
    ]);
  });

  it("skips a request that resolved between the list and the read", async () => {
    const { call } = fakeT3({
      t3_pending_request_list: () => ({ requestIds: ["gone", "req-3"] }),
      t3_pending_request_read: (args) => {
        if (args.requestId === "gone") throw new Error("request not found");
        return { requestId: "req-3", questions: [{ id: "q", question: "Go?", options: [] }] };
      },
    });

    expect(await t3Adapter(call).pendingQuestions("t-1")).toEqual([
      {
        requestId: "req-3",
        questions: [{ id: "q", prompt: "Go?", options: [], multiSelect: false }],
      },
    ]);
  });

  it("returns nothing when no request waits", async () => {
    const { call, calls } = fakeT3({ t3_pending_request_list: () => ({ requestIds: [] }) });
    expect(await t3Adapter(call).pendingQuestions("t-1")).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("t3Adapter.answer", () => {
  it("responds with answers keyed by question ID", async () => {
    const { call, calls } = fakeT3({ t3_pending_request_respond: () => ({ sequence: 5 }) });

    await t3Adapter(call).answer("t-1", "req-1", { "q-env": ["staging"], "q-name": "Ada" });

    expect(calls[0]).toMatchObject({
      name: "t3_pending_request_respond",
      args: {
        threadId: "t-1",
        requestId: "req-1",
        answers: { "q-env": ["staging"], "q-name": "Ada" },
      },
    });
  });
});

describe("t3Adapter.send", () => {
  it("sends the message with its mode and retry key", async () => {
    const { call, calls } = fakeT3({
      t3_thread_send: () => ({ threadId: "t-1", delivery: "steered" }),
    });

    await t3Adapter(call).send("t-1", "Use the retry helper", "steer", "send-J-1-2");

    expect(calls[0]?.args).toEqual({
      threadId: "t-1",
      message: "Use the retry helper",
      mode: "steer",
      clientRequestId: "send-J-1-2",
    });
  });
});

describe("t3Adapter.pullRequests", () => {
  const entry = (extra: Record<string, unknown> = {}) => ({
    host: "github.com",
    repository: "o/r",
    number: 7,
    url: "https://github.com/o/r/pull/7",
    source: "agent",
    watching: false,
    state: "open",
    title: "Add retry",
    headBranch: "feat/retry",
    baseBranch: "main",
    isDraft: true,
    stack: null,
    ...extra,
  });

  it("calls list_thread_pull_requests with the thread and maps the facts", async () => {
    const { call, calls } = fakeT3({
      list_thread_pull_requests: () => ({ pullRequests: [entry()], chains: [] }),
    });

    const result = await t3Adapter(call).pullRequests?.("t-1");

    expect(result).toEqual([
      {
        url: "https://github.com/o/r/pull/7",
        number: 7,
        state: "open",
        headBranch: "feat/retry",
        baseBranch: "main",
        isDraft: true,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "list_thread_pull_requests",
      args: { threadId: "t-1" },
    });
  });

  it("keeps unreported fields as null and an unknown state as unknown", async () => {
    const { call } = fakeT3({
      list_thread_pull_requests: () => ({
        pullRequests: [
          entry({ state: "queued", headBranch: null, baseBranch: undefined, isDraft: undefined }),
        ],
      }),
    });

    expect(await t3Adapter(call).pullRequests?.("t-1")).toEqual([
      {
        url: "https://github.com/o/r/pull/7",
        number: 7,
        state: "unknown",
        headBranch: null,
        baseBranch: null,
        isDraft: null,
      },
    ]);
  });

  it("ignores an entry that does not parse and keeps the others", async () => {
    const { call } = fakeT3({
      list_thread_pull_requests: () => ({
        pullRequests: [
          { url: 7 },
          "nope",
          entry({ number: 8, url: "https://github.com/o/r/pull/8" }),
        ],
      }),
    });

    const result = await t3Adapter(call).pullRequests?.("t-1");

    expect(result?.map((pr) => pr.number)).toEqual([8]);
  });

  it("passes a T3 error to the caller", async () => {
    const call: CallTool = async () => {
      throw new Error("Thread t-1 was not found.");
    };
    await expect(t3Adapter(call).pullRequests?.("t-1")).rejects.toThrow(/not found/);
  });
});

describe("t3Adapter.watchPullRequest", () => {
  it("calls watch_pull_request with the thread and URL, and maps the result", async () => {
    const { call, calls } = fakeT3({
      watch_pull_request: () => ({
        host: "github.com",
        repository: "o/r",
        number: 7,
        url: "https://github.com/o/r/pull/7",
        watching: true,
        wasWatching: false,
      }),
    });

    const result = await t3Adapter(call).watchPullRequest?.(
      "t-1",
      "https://github.com/o/r/pull/7",
      "J-1:watch",
    );

    expect(result).toEqual({ watching: true, alreadyWatching: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "watch_pull_request",
      args: { threadId: "t-1", url: "https://github.com/o/r/pull/7" },
    });
  });

  it("passes a T3 refusal to the caller", async () => {
    const call: CallTool = async () => {
      throw new Error("The pull request is merged, so there is nothing to watch.");
    };
    await expect(t3Adapter(call).watchPullRequest?.("t-1", "u", "k")).rejects.toThrow(/merged/);
  });
});

describe("t3Adapter.health", () => {
  const expiry = new Date("2026-11-01T00:00:00Z");

  it("reports a reachable, signed-in worker with the configured expiry", async () => {
    const { call } = fakeT3({ orchestrator_capabilities: () => ({ providers: [] }) });
    expect(await t3Adapter(call, { signInExpiresAt: expiry }).health?.()).toEqual({
      reachable: true,
      signedIn: true,
      signInExpiresAt: expiry,
    });
  });

  it("reports a refused token as reachable but not signed in", async () => {
    const call: CallTool = async () => {
      throw new Error("Streamable HTTP error: Error POSTing to endpoint (HTTP 401): unauthorized");
    };
    expect(await t3Adapter(call).health?.()).toEqual({
      reachable: true,
      signedIn: false,
      signInExpiresAt: null,
    });
  });

  it("reports an unreachable worker", async () => {
    const call: CallTool = async () => {
      throw new Error("fetch failed");
    };
    expect(await t3Adapter(call).health?.()).toMatchObject({ reachable: false, signedIn: false });
  });
});
