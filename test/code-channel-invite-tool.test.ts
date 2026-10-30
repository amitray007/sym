import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import dynamic from "../agent/tools/code_channel_invite.ts";
import { createJob, updateJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { ledgerDeps } from "../lib/runtime.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

vi.mock("../lib/runtime.ts", () => ({ ledgerDeps: vi.fn() }));
interface Context {
  session: { id: string; auth: { current: { principalId: string } } };
}
interface InviteTool {
  inputSchema: z.ZodType<{ job?: string; people: string[] }>;
  execute(input: { job?: string; people: string[] }, ctx: Context): Promise<unknown>;
}
const ctx = (principalId = "slack:T1:UREQUESTER", id = "invite-session"): Context => ({
  session: { id, auth: { current: { principalId } } },
});
const run = Object.getOwnPropertySymbols(dynamic)
  .map((key) => (dynamic as unknown as Record<symbol, unknown>)[key])
  .find((value) => typeof value === "function") as (context: Context) => InviteTool | null;
function tool(): InviteTool {
  vi.stubEnv("SYM_CODE_CHANNELS", "on");
  const value = run(ctx());
  if (!value) throw new Error("missing invite tool");
  return value;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("offers the tool only with code channels on and never to workers", async () => {
  vi.stubEnv("SYM_CODE_CHANNELS", "off");
  expect(run(ctx())).toBeNull();
  const value = tool();
  expect(run(ctx("sym-worker"))).toBeNull();
  expect(await value.execute({ people: ["UTEAMMATE"] }, ctx("sym-worker"))).toBe(
    "Worker threads cannot call this tool.",
  );
  expect(ledgerDeps).not.toHaveBeenCalled();
});

it("normalizes mentions and enforces valid IDs and the 10-person limit in its schema", () => {
  const schema = tool().inputSchema;
  expect(schema.parse({ people: ["<@UTEAMMATE>", "WOTHER"] })).toEqual({
    people: ["UTEAMMATE", "WOTHER"],
  });
  expect(schema.safeParse({ people: ["Sam"] }).success).toBe(false);
  expect(schema.safeParse({ people: [] }).success).toBe(false);
  expect(schema.safeParse({ people: Array(11).fill("UTEAMMATE") }).success).toBe(false);
});

describe.skipIf(!hasDatabase)("invite job resolution", () => {
  const ledger = useLedger();
  let counter = 0;
  async function setup() {
    counter += 1;
    const sql = ledger.sql();
    const sessionId = `invite-session-${counter}`;
    const work = await createJob(sql, {
      requestKey: sessionId,
      title: "Retry work",
      kind: "code-change",
      worker: "fake",
      brief: {},
      slackChannel: "CORIGIN",
      slackThreadTs: sessionId,
    });
    const moved = await updateJob(sql, work.id, {
      slackChannel: `CCODE${counter}`,
      slackThreadTs: null,
      codeChannel: true,
      originChannel: "CORIGIN",
      originThreadTs: sessionId,
    });
    const call = vi.fn<SlackApi["call"]>().mockImplementation(async (method) =>
      method === "conversations.info"
        ? {
            channel: {
              is_private: false,
              properties: { record_channel: { record_type: "agent_channel" } },
            },
          }
        : {},
    );
    vi.mocked(ledgerDeps).mockReturnValue({ sql, slack: { call }, allowedProjects: [] });
    vi.stubEnv("SYM_SLACK_USERS", "UREQUESTER");
    const record = (channelId: string, threadTs: string | null) =>
      recordSessionThread(sql, {
        sessionId,
        channelId,
        threadTs,
        userId: "UREQUESTER",
        teamId: "T1",
      });
    return { work: moved, call, record, context: ctx("slack:T1:UREQUESTER", sessionId) };
  }

  it("uses the job of the current code channel, even in a reply thread", async () => {
    const s = await setup();
    await s.record(s.work.slackChannel ?? "", "reply-thread");
    expect(await tool().execute({ people: ["UTEAMMATE"] }, s.context)).toMatchObject({
      results: [{ status: "invited" }],
    });
    expect(s.call).toHaveBeenCalledWith("conversations.invite", {
      channel: s.work.slackChannel,
      users: "UTEAMMATE",
    });
  });

  it("uses the moved job of the current origin thread", async () => {
    const s = await setup();
    await s.record("CORIGIN", s.work.originThreadTs);
    expect(await tool().execute({ people: ["UTEAMMATE"] }, s.context)).toMatchObject({
      results: [{ status: "invited" }],
    });
    expect(s.call).toHaveBeenCalledWith("conversations.invite", {
      channel: s.work.slackChannel,
      users: "UTEAMMATE",
    });
  });

  it("accepts an explicit job handle without a recorded conversation", async () => {
    const s = await setup();
    expect(
      await tool().execute({ job: `J-${s.work.id}`, people: ["UTEAMMATE"] }, s.context),
    ).toMatchObject({ work: "Retry work", results: [{ status: "invited" }] });
  });

  it("plainly refuses when the conversation has no job", async () => {
    const s = await setup();
    await s.record("CUNRELATED", "other-thread");
    expect(await tool().execute({ people: ["UTEAMMATE"] }, s.context)).toBe(
      "I couldn't find the work for this request.",
    );
    expect(s.call).not.toHaveBeenCalled();
  });
});
