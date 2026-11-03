import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import type { LedgerDeps } from "../lib/jobs/run.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { getTrigger, parseTriggerRef } from "../lib/triggers/rows.ts";
import { NOT_WATCHABLE, TRIGGER_NOT_ALLOWED } from "../lib/triggers/setup.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  slack: undefined as SlackApi | undefined,
}));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  ledgerDeps: (): LedgerDeps =>
    ({
      sql: runtime.sql,
      allowedProjects: [],
      ...(runtime.slack ? { slack: runtime.slack } : {}),
    }) as LedgerDeps,
  pack: () => undefined,
}));

import scheduleCreate from "../agent/tools/schedule_create.ts";
import triggerCreate from "../agent/tools/trigger_create.ts";
import triggerDelete from "../agent/tools/trigger_delete.ts";
import triggerList from "../agent/tools/trigger_list.ts";
import triggerPause from "../agent/tools/trigger_pause.ts";

// Decision 088: anyone on the allow-list sets up and changes triggers with no owner approval, in
// a channel that the person and Sym both belong to. A run cannot set up triggers or schedules.

const ALLOWED = "slack:T1:UALLOWED";
const STRANGER = "slack:T1:USTRANGER";
// The principal a run starts as (decisions 085 and 088).
const RUN = "eve:app";

const ctx = (principalId: string, id: string) => ({
  session: { id, auth: { current: { principalId } } },
  callId: "call-1",
});
// biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
const call = (tool: any, input: unknown, principalId = ALLOWED, session = "here-session") =>
  tool.execute(input, ctx(principalId, session)) as Promise<
    string | { trigger: string; answer: string }
  >;

const base = {
  title: "Bug triage",
  instruction: "Draft a ticket for each bug report.",
  on: "message",
  keywords: [],
  builder: "ask",
};

// Channel facts: who is in each channel, and whether Sym is.
function slackWith(members: Record<string, string[]>, symIn: string[]): SlackApi {
  return {
    call: vi.fn(async (method: string, body: Record<string, unknown>) => {
      const channel = String(body.channel);
      if (method === "conversations.info") {
        return { channel: { id: channel, is_private: false, is_member: symIn.includes(channel) } };
      }
      if (method === "conversations.members") return { members: members[channel] ?? [] };
      if (method === "conversations.open") return { channel: { id: `D${String(body.users)}` } };
      throw new Error(`unexpected ${method}`);
    }),
  };
}

describe.skipIf(!hasDatabase)("trigger tools", () => {
  const ledger = useLedger();

  beforeEach(async () => {
    runtime.sql = ledger.sql();
    runtime.slack = slackWith(
      { CHERE: ["UALLOWED", "UOTHER"], CTHEIRS: ["UOTHER"], CNOSYM: ["UALLOWED"] },
      ["CHERE", "CTHEIRS"],
    );
    vi.stubEnv("SYM_SLACK_USERS", "UALLOWED,UOTHER");
    await recordSessionThread(ledger.sql(), {
      sessionId: "here-session",
      channelId: "CHERE",
      threadTs: "1.1",
      teamId: "T1",
      userId: "UALLOWED",
    });
    await recordSessionThread(ledger.sql(), {
      sessionId: "dm-session",
      channelId: "DUALLOWED",
      threadTs: null,
      teamId: "T1",
      userId: "UALLOWED",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  const created = async (input: unknown, principalId = ALLOWED, session = "here-session") => {
    const result = await call(triggerCreate, input, principalId, session);
    if (typeof result === "string") throw new Error(result);
    const row = await getTrigger(ledger.sql(), parseTriggerRef(result.trigger) ?? 0);
    if (!row) throw new Error("no row");
    return row;
  };

  it("has no approval step", () => {
    expect((triggerCreate as { approval?: unknown }).approval).toBeUndefined();
  });

  it("creates an active trigger on this channel for an allowed person", async () => {
    const row = await created({ ...base, keywords: [" bug ", "outage"] });
    expect(row).toMatchObject({
      kind: "message",
      channel: "CHERE",
      keywords: ["bug", "outage"],
      emoji: null,
      destination: null,
      owner: "UALLOWED",
      status: "active",
      builder: "ask",
    });
  });

  it("creates a reaction trigger with a normalized emoji and a DM destination", async () => {
    const row = await created({
      ...base,
      on: "reaction",
      emoji: ":Eyes:",
      builder: "auto",
      destination: "dm",
      channel: "CHERE",
    });
    expect(row).toMatchObject({ kind: "reaction", emoji: "eyes", destination: "DUALLOWED" });
    expect(row.keywords).toEqual([]);
    expect(await call(triggerCreate, { ...base, on: "reaction" })).toBe(
      "Name the emoji to watch for.",
    );
  });

  it("refuses a person off the allow-list, a worker, and a run", async () => {
    expect(await call(triggerCreate, base, STRANGER)).toBe(TRIGGER_NOT_ALLOWED);
    expect(await call(triggerCreate, base, "sym-worker")).toMatch(/Worker threads/);
    expect(await call(triggerCreate, base, RUN)).toBe(TRIGGER_NOT_ALLOWED);
    // Nor can a run set up a schedule.
    expect(await call(scheduleCreate, { ...base, cron: "0 9 * * *" }, RUN)).toMatch(/allow-list/);
    expect(await ledger.sql()`select id from triggers where owner = 'USTRANGER'`).toHaveLength(0);
  });

  it("watches only a channel that the person and Sym are both in", async () => {
    // Sym is not in it: Slack would send no events.
    expect(await call(triggerCreate, { ...base, channel: "CNOSYM" })).toBe(NOT_WATCHABLE);
    // The person is not in it.
    expect(await call(triggerCreate, { ...base, channel: "CTHEIRS" })).toBe(NOT_WATCHABLE);
    // A DM cannot be watched.
    expect(await call(triggerCreate, base, ALLOWED, "dm-session")).toBe(NOT_WATCHABLE);
    expect(
      await call(triggerCreate, { ...base, channel: "<#CHERE>" }, ALLOWED, "dm-session"),
    ).toMatchObject({
      answer: expect.stringContaining("Slack sends me its events"),
    });
  });

  it("refuses a destination the person cannot reach", async () => {
    expect(await call(triggerCreate, { ...base, destination: "CTHEIRS" })).toBe(
      "I can't reach that conversation.",
    );
  });

  it("lists, pauses, resumes, and deletes for any allowed person", async () => {
    const row = await created({ ...base, title: "Shared triage" });
    const ref = `T-${row.id}`;
    const other = "slack:T1:UOTHER";
    expect(await call(triggerPause, { trigger: ref }, STRANGER)).toBe(TRIGGER_NOT_ALLOWED);
    expect(await call(triggerPause, { trigger: ref }, RUN)).toBe(TRIGGER_NOT_ALLOWED);
    expect(await call(triggerPause, { trigger: ref }, other)).toMatchObject({
      answer: expect.stringContaining("Paused"),
    });
    expect(await call(triggerPause, { trigger: ref, resume: true }, other)).toMatchObject({
      answer: expect.stringContaining("Resumed"),
    });
    const listed = (await triggerList.execute({} as never, ctx(other, "x") as never)) as {
      summary: string;
    };
    expect(listed.summary).toContain("Shared triage: on a new message in <#CHERE> - active");
    expect(await call(triggerDelete, { trigger: ref, title: "Wrong" }, other)).toMatch(
      /doesn't match/,
    );
    expect(await call(triggerDelete, { trigger: ref, title: row.title }, other)).toMatchObject({
      answer: "Deleted Shared triage.",
    });
    expect((await getTrigger(ledger.sql(), row.id))?.status).toBe("deleted");
  });
});
