import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import tool from "../agent/tools/job_close.ts";
import { createJob, updateJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { ledgerDeps, withJobDeps } from "../lib/runtime.ts";
import { SlackApiError } from "../lib/slack/api.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

vi.mock("../lib/runtime.ts", () => ({
  ledgerDeps: vi.fn(),
  withJobDeps: vi.fn(),
  pack: () => undefined,
}));
const ctx = (principalId = "slack:T1:U1", id = "close-session") =>
  ({ session: { id, auth: { current: { principalId } } } }) as Parameters<
    NonNullable<typeof tool.execute>
  >[1];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("accepts no ref and refuses an unauthorized tool caller before loading dependencies", async () => {
  vi.stubEnv("SYM_SLACK_USERS", "U1");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((tool.inputSchema as z.ZodType).parse({})).toEqual({});
  expect(await tool.execute?.({}, ctx("slack:T1:UOTHER"))).toEqual({
    status: "refused",
    reason: "This needs an allowed person in Slack.",
  });
  expect(ledgerDeps).not.toHaveBeenCalled();
  expect(withJobDeps).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe.skipIf(!hasDatabase)("close tool channel resolution", () => {
  const ledger = useLedger();
  async function setup() {
    vi.stubEnv("SYM_SLACK_USERS", "U1");
    const call = vi.fn().mockResolvedValue({
      channel: { properties: { record_channel: { record_type: "agent_channel" } } },
    });
    vi.mocked(ledgerDeps).mockReturnValue({ sql: ledger.sql(), slack: { call } });
    await recordSessionThread(ledger.sql(), {
      sessionId: "close-session",
      channelId: "CCONVERSATION",
      threadTs: null,
      userId: "U1",
      teamId: "T1",
    });
    return call;
  }

  it("closes the current conversation channel without opening a worker connection", async () => {
    const call = await setup();
    expect(await tool.execute?.({}, ctx())).toBe("Closed this and archived its channel.");
    expect(call).toHaveBeenCalledWith("agents.conversations.archive", {
      channel_id: "CCONVERSATION",
    });
    expect(withJobDeps).not.toHaveBeenCalled();
  });

  it("reports a missing conversation and Slack refusal plainly", async () => {
    const call = await setup();
    expect(await tool.execute?.({}, ctx("slack:T1:U1", "missing"))).toBe(
      "I couldn't find this conversation's code channel.",
    );
    call.mockRejectedValueOnce(new SlackApiError("conversations.info", "channel_not_found"));
    expect(await tool.execute?.({}, ctx())).toBe("Slack refused: channel_not_found.");
  });

  it("keeps explicit refs working and names work when closing from another conversation", async () => {
    await setup();
    const sql = ledger.sql();
    const worker = new FakeWorker();
    vi.mocked(withJobDeps).mockImplementation(async (fn) => fn({ sql, worker }));
    const work = await createJob(sql, {
      requestKey: "explicit-close",
      title: "Retry work",
      kind: "code-change",
      worker: "fake",
      brief: {},
    });
    await updateJob(sql, work.id, { status: "done" });
    expect(await tool.execute?.({ ref: `J-${work.id}` }, ctx())).toBe("Retry work: Closed this.");
    expect(withJobDeps).toHaveBeenCalledOnce();
  });
});
