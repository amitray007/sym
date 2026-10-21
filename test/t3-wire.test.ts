import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOutputContract } from "../lib/jobs/contract.ts";
import { t3Adapter } from "../lib/workers/t3/adapter.ts";
import { connectT3, type T3Connection } from "../lib/workers/t3/client.ts";
import type { WorkerAdapter } from "../lib/workers/types.ts";
import { type FakeT3, type FakeT3Step, startFakeT3 } from "./fakes/t3-server.ts";

// Real MCP client against the fake T3 server on 127.0.0.1: the transport, auth, and result
// parsing run for real. Only T3 itself is fake.

const projects = [
  { id: "p-1", title: "alpha", workspaceRoot: "/repos/alpha" },
  { id: "p-2", title: "beta", workspaceRoot: "/repos/beta" },
  { id: "p-3", title: "gamma", workspaceRoot: "/repos/gamma" },
];

const question = {
  requestId: "req-1",
  questions: [
    {
      id: "q-env",
      header: "Target",
      question: "Which environment?",
      options: [
        { label: "staging", description: "Safe" },
        { label: "production", description: "Careful" },
      ],
    },
  ],
};

let t3: FakeT3;
let connection: T3Connection;
let worker: WorkerAdapter;

beforeAll(async () => {
  t3 = await startFakeT3({ projects, pageSize: 2 });
  connection = await connectT3({ url: t3.url, getToken: async () => t3.token });
  worker = t3Adapter(connection.call);
});

afterAll(async () => {
  await connection.close();
  await t3.close();
});

const launch = (title: string) =>
  worker.launch({ projectId: "p-1", title, message: "brief", baseRef: "main" });

describe("t3 over the wire", () => {
  it("reads capabilities", async () => {
    const { providers } = await worker.capabilities();
    expect(providers.map((p) => p.id)).toEqual(["fake", "claudeAgent", "codex"]);
    expect(providers[0]).toEqual({
      id: "fake",
      name: "Fake",
      models: ["fake-model"],
      modelOptions: { "fake-model": [] },
      available: true,
    });
    expect(providers[1]?.modelOptions?.["claude-opus-5-5"]).toEqual([
      { id: "effort", values: ["low", "medium", "high"] },
    ]);
    expect(providers[2]?.modelOptions?.["gpt-6-luna"]).toEqual([
      { id: "reasoningEffort", values: ["low", "medium", "high"] },
    ]);
  });

  it("pages through projects", async () => {
    t3.calls.length = 0;
    expect(await worker.projects()).toEqual(projects);
    const pages = t3.calls.filter((call) => call.name === "t3_project_list");
    expect(pages.map((call) => call.args.cursor)).toEqual([undefined, 2]);
  });

  it("launches, waits, and reads activity to completion", async () => {
    t3.setScript([
      { status: "running", items: ["Reading the code"] },
      { status: "completed", items: ["Opened PR", "Done"] },
    ]);
    const thread = await launch("[J-1] Retry");
    expect(thread).toEqual({ id: expect.any(String), title: "[J-1] Retry", status: "running" });

    expect(await worker.wait(thread.id, 1000)).toEqual({ status: "running", timedOut: true });
    const first = await worker.readActivity(thread.id, null);
    expect(first.items.map((item) => item.text)).toEqual(["Reading the code"]);

    expect(await worker.wait(thread.id, 1000)).toEqual({ status: "completed", timedOut: false });
    const second = await worker.readActivity(thread.id, first.cursor);
    expect(second).toMatchObject({ status: "completed", pendingRequests: 0, hasMore: false });
    expect(second.items.map((item) => item.text)).toEqual(["Opened PR", "Done"]);

    const empty = await worker.readActivity(thread.id, second.cursor);
    expect(empty.items).toEqual([]);
    expect(empty.cursor).toBe(second.cursor);
  });

  it("finds a launched thread by its title prefix", async () => {
    const thread = await launch("[J-2] Find me");

    expect(await worker.findByTitle("p-1", "[J-2]")).toEqual({
      id: thread.id,
      title: "[J-2] Find me",
      status: "running",
    });
    expect(await worker.findByTitle("p-1", "[J-404]")).toBeUndefined();
    expect(await worker.findByTitle("p-2", "[J-2]")).toBeUndefined();
  });

  it("pages thread activity with hasMore", async () => {
    const many: FakeT3Step[] = [
      { status: "completed", items: Array.from({ length: 101 }, (_, i) => `item ${i}`) },
    ];
    t3.setScript(many);
    const thread = await launch("[J-3] Long run");
    await worker.wait(thread.id, 1000);

    const first = await worker.readActivity(thread.id, null);
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const rest = await worker.readActivity(thread.id, first.cursor);
    expect(rest.items.map((item) => item.text)).toEqual(["item 100"]);
    expect(rest.hasMore).toBe(false);
  });

  it("reads the whole last message, so a result block after a long report still parses", async () => {
    const report = "A long report line.\n".repeat(400);
    const block = '```json\n{"summary": "Found it", "pr_url": null}\n```';
    t3.setScript([{ status: "completed", items: ["x".repeat(9000), `${report}${block}`] }]);
    const thread = await launch("[J-5] Long report");
    await worker.wait(thread.id, 1000);

    const { items } = await worker.readActivity(thread.id, null);
    expect(items.map((item) => item.text.length)).toEqual([4000, 4000]);
    const last = items[1];
    if (!last?.rest) throw new Error("the last message was not marked as cut");
    const whole =
      last.text + (await worker.readRest?.(thread.id, last.rest.itemId, last.rest.offset));
    expect(whole).toBe(`${report}${block}`);
    expect(parseOutputContract(whole)?.summary).toBe("Found it");
  });

  it("interrupts a running thread once per request ID", async () => {
    t3.setScript([{ status: "running" }]);
    const thread = await launch("[J-4] Stop me");
    await worker.wait(thread.id, 1000);

    await worker.interrupt(thread.id, "Cancelled in Sym", "cancel-J-4");
    await worker.interrupt(thread.id, "Cancelled in Sym", "cancel-J-4");

    const stored = t3.threads.get(thread.id);
    expect(stored?.status).toBe("interrupted");
    expect(stored?.interrupts).toEqual([
      { reason: "Cancelled in Sym", clientRequestId: "cancel-J-4" },
    ]);
    expect((await worker.readActivity(thread.id, null)).status).toBe("interrupted");
  });

  it("asks a question, takes the answer, and finishes", async () => {
    t3.setScript([
      { status: "waiting", items: ["Which environment?"], questions: [question] },
      { status: "completed", items: ["Deployed"] },
    ]);
    const thread = await launch("[J-5] Ask");

    expect(await worker.wait(thread.id, 1000)).toEqual({ status: "waiting", timedOut: false });
    expect((await worker.readActivity(thread.id, null)).pendingRequests).toBe(1);
    const asked = await worker.pendingQuestions(thread.id);
    expect(asked).toEqual([
      {
        requestId: "req-1",
        questions: [
          {
            id: "q-env",
            header: "Target",
            prompt: "Which environment?",
            options: [
              { label: "staging", description: "Safe" },
              { label: "production", description: "Careful" },
            ],
            multiSelect: false,
          },
        ],
      },
    ]);

    await worker.answer(thread.id, "req-1", { "q-env": "staging" });

    expect(t3.threads.get(thread.id)?.answers).toEqual([
      { requestId: "req-1", answers: { "q-env": "staging" } },
    ]);
    expect(await worker.pendingQuestions(thread.id)).toEqual([]);
    expect(await worker.wait(thread.id, 1000)).toEqual({ status: "completed", timedOut: false });
    await expect(worker.answer(thread.id, "req-1", { "q-env": "staging" })).rejects.toThrow(
      "not found",
    );
  });

  it("sends a message with a client request ID, once", async () => {
    t3.setScript([{ status: "running" }]);
    const thread = await launch("[J-6] Steer");
    await worker.wait(thread.id, 1000);

    await worker.send(thread.id, "Use the retry helper", "steer", "send-J-6-1");
    await worker.send(thread.id, "Use the retry helper", "steer", "send-J-6-1");

    expect(t3.threads.get(thread.id)?.sends).toEqual([
      { message: "Use the retry helper", mode: "steer", clientRequestId: "send-J-6-1" },
    ]);
  });

  it("reports a tool error for an unknown thread", async () => {
    await expect(worker.wait("thread-missing", 1000)).rejects.toThrow("was not found");
  });
});

describe("t3 pull request watch over the wire", () => {
  const prUrl = "https://github.com/example/app/pull/12";

  it("links and watches a pull request, and a repeat reports it as already watched", async () => {
    const thread = await launch("[J-9] Watch me");
    t3.calls.length = 0;

    expect(await worker.watchPullRequest?.(thread.id, prUrl, "J-9:watch")).toEqual({
      watching: true,
      alreadyWatching: false,
    });
    expect(await worker.watchPullRequest?.(thread.id, prUrl, "J-9:watch")).toEqual({
      watching: true,
      alreadyWatching: true,
    });
    expect(t3.calls.map((call) => call.name)).toEqual(["watch_pull_request", "watch_pull_request"]);
    expect(t3.calls[0]?.args).toEqual({ threadId: thread.id, url: prUrl });
    expect(t3.threads.get(thread.id)?.pullRequests).toEqual([{ url: prUrl, watching: true }]);
  });

  it("lists the pull requests linked to a thread, with the facts T3 reports", async () => {
    const thread = await launch("[J-11] Facts");
    expect(await worker.pullRequests?.(thread.id)).toEqual([]);
    const linked = t3.threads.get(thread.id);
    linked?.pullRequests.push({
      url: prUrl,
      watching: false,
      state: "open",
      headBranch: "feat/x",
      baseBranch: "main",
      isDraft: true,
    });

    expect(await worker.pullRequests?.(thread.id)).toEqual([
      {
        url: prUrl,
        number: 12,
        state: "open",
        headBranch: "feat/x",
        baseBranch: "main",
        isDraft: true,
      },
    ]);
  });

  it("surfaces a T3 refusal", async () => {
    const thread = await launch("[J-10] Merged");
    t3.failNextWatch("The pull request is merged, so there is nothing to watch.");
    await expect(worker.watchPullRequest?.(thread.id, prUrl, "k")).rejects.toThrow(/merged/);
  });

  it("reads a wake as a notification activity item", async () => {
    const thread = await launch("[J-11] Wake");
    t3.addWake(thread.id, "#12: checks failed");
    const activity = await worker.readActivity(thread.id, null);
    expect(activity.items).toEqual([
      { position: 0, type: "notification", text: "#12: checks failed" },
    ]);
  });

  it("reports health over the wire", async () => {
    expect(await worker.health?.()).toMatchObject({ reachable: true, signedIn: true });
  });
});

describe("t3 auth", () => {
  it("refuses a wrong bearer token", async () => {
    const before = t3.unauthorized;
    await expect(connectT3({ url: t3.url, getToken: async () => "wrong" })).rejects.toThrow();
    expect(t3.unauthorized).toBeGreaterThan(before);
  });
});
