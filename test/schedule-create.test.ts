import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import type { LedgerDeps } from "../lib/jobs/run.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { NOT_ALLOWED } from "../lib/schedules/access.ts";
import { getSchedule, parseScheduleRef } from "../lib/schedules/rows.ts";
import type { SlackApi } from "../lib/slack/api.ts";
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
import scheduleDelete from "../agent/tools/schedule_delete.ts";
import schedulePause from "../agent/tools/schedule_pause.ts";

// Decision 085: anyone on the allow-list sets up and changes schedules, with no owner approval.

const ALLOWED = "slack:T1:UALLOWED";
const STRANGER = "slack:T1:USTRANGER";

const ctx = (principalId: string, id = "create-session") => ({
  session: { id, auth: { current: { principalId } } },
  callId: "call-1",
});
// biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
const call = (tool: any, input: unknown, principalId = ALLOWED, session?: string) =>
  tool.execute(input, ctx(principalId, session)) as Promise<
    string | { schedule: string; answer: string }
  >;

const later = new Date(Date.now() + 3600_000).toISOString();
const base = {
  title: "Open PR check",
  instruction: "List the open pull requests.",
  builder: "ask",
};

describe.skipIf(!hasDatabase)("schedule tools", () => {
  const ledger = useLedger();

  beforeEach(async () => {
    runtime.sql = ledger.sql();
    runtime.slack = undefined;
    vi.stubEnv("SYM_SLACK_USERS", "UALLOWED,UOTHER");
    await recordSessionThread(ledger.sql(), {
      sessionId: "create-session",
      channelId: "CHERE",
      threadTs: "1.1",
      teamId: "T1",
      userId: "UALLOWED",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  const created = async (input: unknown, principalId = ALLOWED) => {
    const result = await call(scheduleCreate, input, principalId);
    if (typeof result === "string") throw new Error(result);
    const row = await getSchedule(ledger.sql(), parseScheduleRef(result.schedule) ?? 0);
    if (!row) throw new Error("no row");
    return row;
  };

  it("has no approval step", () => {
    expect((scheduleCreate as { approval?: unknown }).approval).toBeUndefined();
    expect((scheduleDelete as { approval?: unknown }).approval).toBeUndefined();
  });

  it("creates an active schedule for an allowed person, posting in this channel", async () => {
    const row = await created({ ...base, cron: "0 9 * * 1-5" });
    expect(row).toMatchObject({
      status: "active",
      owner: "UALLOWED",
      channel: "CHERE",
      builder: "ask",
      instruction: base.instruction,
    });
    expect(row.nextFireAt).not.toBeNull();
  });

  it("creates a one-time schedule from an `at` time", async () => {
    const row = await created({ ...base, at: later, builder: "auto" });
    expect(row).toMatchObject({ cron: null, builder: "auto", status: "active" });
    expect(row.runAt?.toISOString()).toBe(later);
  });

  it("refuses a person outside the allow-list, a worker, and a scheduled run", async () => {
    for (const principal of [STRANGER, "sym-worker", "eve:app"]) {
      expect(await call(scheduleCreate, { ...base, cron: "0 9 * * *" }, principal)).toMatch(
        /allow-list|Worker threads/,
      );
    }
    expect(await call(scheduleCreate, { ...base, cron: "0 9 * * *" }, STRANGER)).toBe(NOT_ALLOWED);
    const count = await ledger.sql()`select id from schedules where owner = 'USTRANGER'`;
    expect(count).toHaveLength(0);
  });

  it("needs exactly one of cron and at, and a time ahead", async () => {
    expect(await call(scheduleCreate, base)).toMatch(/cron or a one-time/);
    expect(await call(scheduleCreate, { ...base, cron: "0 9 * * *", at: later })).toMatch(
      /not both/,
    );
    expect(await call(scheduleCreate, { ...base, at: "2020-01-01T00:00:00Z" })).toBe(
      "That time has passed.",
    );
  });

  it("posts a DM destination in the creator's DM channel", async () => {
    const slackCall = vi.fn(async (method: string) =>
      method === "conversations.open" ? { ok: true, channel: { id: "DCREATOR" } } : { ok: true },
    );
    runtime.slack = { call: slackCall } as unknown as SlackApi;
    const row = await created({ ...base, cron: "0 9 * * *", destination: "dm" });
    expect(row.channel).toBe("DCREATOR");
    expect(slackCall).toHaveBeenCalledWith("conversations.open", { users: "UALLOWED" });
  });

  it("refuses another channel the person cannot reach", async () => {
    expect(await call(scheduleCreate, { ...base, cron: "0 9 * * *", destination: "COTHER" })).toBe(
      "I can't reach that conversation.",
    );
  });

  it("lets another allowed person pause, resume, and delete, and refuses a stranger", async () => {
    const row = await created({ ...base, cron: "0 9 * * *", title: "Shared check" });
    const ref = `S-${row.id}`;
    const other = "slack:T1:UOTHER";
    expect(await call(schedulePause, { schedule: ref }, STRANGER)).toBe(NOT_ALLOWED);
    expect(await call(scheduleDelete, { schedule: ref, title: row.title }, STRANGER)).toBe(
      NOT_ALLOWED,
    );
    expect(await call(schedulePause, { schedule: ref }, other)).toMatchObject({
      answer: expect.stringContaining("Paused"),
    });
    expect(await call(schedulePause, { schedule: ref, resume: true }, other)).toMatchObject({
      answer: expect.stringContaining("Resumed"),
    });
    expect(await call(scheduleDelete, { schedule: ref, title: row.title }, other)).toMatchObject({
      answer: "Deleted Shared check.",
    });
    expect((await getSchedule(ledger.sql(), row.id))?.status).toBe("deleted");
  });
});
