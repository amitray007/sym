import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import rootAgent from "../agent/agent.ts";
import researcherAgent from "../agent/subagents/researcher/agent.ts";
import status from "../agent/subagents/researcher/tools/jobs_status.ts";
import read from "../agent/subagents/researcher/tools/slack_read.ts";
import researcher from "../agent/tools/research.ts";
import { NOT_FOR_WORKERS } from "../lib/callers.ts";
import { readInTurn } from "../lib/slack/read.ts";

const mocks = vi.hoisted(() => ({
  ledger: vi.fn(),
  recentJobs: vi.fn().mockResolvedValue([]),
  getJobByRef: vi.fn(),
  readConversation: vi.fn(),
}));
vi.mock("../lib/runtime.ts", () => ({
  ledger: mocks.ledger,
  pack: () => undefined,
  slackFromEnv: () => ({}),
}));
vi.mock("../lib/ledger/jobs.ts", async (original) => ({
  ...(await original<object>()),
  recentJobs: mocks.recentJobs,
  getJobByRef: mocks.getJobByRef,
}));
vi.mock("../lib/slack/read.ts", async (original) => ({
  ...(await original<object>()),
  readConversation: mocks.readConversation,
}));

type ResearchContext = Parameters<typeof researcher.task>[1];
function context(principalId = "slack:T1:U1") {
  const send = vi.fn().mockResolvedValue({
    result: async () => ({ status: "completed", reply: "Evidence from two sources." }),
  });
  const agent = vi.fn().mockReturnValue({ send });
  return {
    agent,
    send,
    ctx: {
      agent,
      session: { id: "root", auth: { current: { principalId } }, turn: { id: "turn" } },
      abortSignal: new AbortController().signal,
    } as unknown as ResearchContext,
  };
}

afterEach(() => vi.clearAllMocks());

describe("researcher boundary", () => {
  it("declares exactly four read-only tools and disables defaults and root copies", () => {
    const names = readdirSync(new URL("../agent/subagents/researcher/tools/", import.meta.url))
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();
    expect(names).toEqual(["jobs_status", "slack_read", "web_fetch", "web_search"]);
    expect(names).not.toEqual(expect.arrayContaining(["worker_job", "slack_post"]));
    expect(researcherAgent.defaultTools).toBe(false);
    expect(researcherAgent.tool).toBe(false);
    expect(rootAgent.defaultTools).toBe(false);
    expect(rootAgent.tool).toBe(false);
  });

  it("calls the declared child with cancellation and returns its evidence", async () => {
    const { ctx, agent, send } = context();
    expect(await researcher.task({ message: "Compare two sources." }, ctx)).toEqual({
      answer: "Evidence from two sources.",
    });
    expect(agent).toHaveBeenCalledWith("researcher");
    expect(send).toHaveBeenCalledWith("Compare two sources.", { signal: ctx.abortSignal });
  });

  it("refuses workers before opening a child or reading the ledger", async () => {
    const { ctx, agent } = context("sym-worker");
    expect(await researcher.task({ message: "Investigate" }, ctx)).toBe(NOT_FOR_WORKERS);
    expect(agent).not.toHaveBeenCalled();
    expect(await status.execute({}, ctx as never)).toBe(NOT_FOR_WORKERS);
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("reads ledger snapshots without refreshing a worker", async () => {
    const { ctx } = context();
    mocks.getJobByRef.mockResolvedValue({
      id: 7,
      title: "Saved work",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date("2026-11-03T00:00:00Z"),
    });
    expect(await status.execute({ job: "J-7" }, ctx as never)).toMatchObject({
      source: "ledger",
      jobs: [{ job: "J-7", status: "running", updatedAt: "2026-11-03T00:00:00.000Z" }],
    });
    expect(mocks.getJobByRef).toHaveBeenCalledWith(undefined, "J-7");
    expect(mocks.recentJobs).not.toHaveBeenCalled();
  });

  it("checks Slack privacy in the parent conversation and marks the parent turn", async () => {
    const { ctx } = context();
    const child = {
      ...ctx,
      session: {
        ...ctx.session,
        id: "child",
        parent: { sessionId: "root", rootSessionId: "root", turn: { id: "read-turn" } },
      },
    } as unknown as Parameters<typeof read.execute>[1];
    mocks.readConversation.mockResolvedValue({ messages: [{ text: "Untrusted source text" }] });
    await read.execute({ target: "#release" }, child);
    expect(mocks.readConversation).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "root",
      requester: "U1",
      target: "#release",
    });
    expect(readInTurn({ id: "root", turn: { id: "read-turn" } })).toBe(true);
    expect(readInTurn({ id: "child", turn: { id: "turn" } })).toBe(false);
  });
});
