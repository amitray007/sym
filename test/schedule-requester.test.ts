import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "../lib/callers.ts";
import type { Sql } from "../lib/db.ts";
import type { LedgerDeps } from "../lib/jobs/run.ts";
import { requesterOf, requesterResponse } from "../lib/requester.ts";
import { turnOutcome } from "../lib/schedules/outcome.ts";
import {
  attachSession,
  createSchedule,
  finishRunWithoutJob,
  reserveRun,
  runsSince,
} from "../lib/schedules/rows.ts";
import { UNREACHABLE } from "../lib/slack/reach.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const runtime = vi.hoisted(() => ({ sql: undefined as Sql | undefined }));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  ledgerDeps: () => ({ sql: runtime.sql, allowedProjects: [] }) as unknown as LedgerDeps,
  pack: () => undefined,
  slackFromEnv: () => undefined,
}));
vi.mock("../lib/slack/slack-post.ts", async (original) => {
  const real = await original<typeof import("../lib/slack/slack-post.ts")>();
  return { ...real, postToConversation: vi.fn(real.postToConversation) };
});
vi.mock("../lib/reactions/react.ts", async (original) => {
  const real = await original<typeof import("../lib/reactions/react.ts")>();
  return { ...real, reactToLinkedMessage: vi.fn(async () => "Reacted.") };
});

import slackPost from "../agent/tools/slack_post.ts";
import slackReact from "../agent/tools/slack_react.ts";
import { reactToLinkedMessage } from "../lib/reactions/react.ts";
import { postToConversation } from "../lib/slack/slack-post.ts";

// Decision 085: a scheduled run acts for the schedule's creator while they stay allowed. The
// session still starts as the app principal, so worker_job can tell it is a run.

const T0 = new Date("2026-11-03T08:00:00Z");
// The principal a schedule handler passes as appAuth.
const APP = {
  principalId: "eve:app",
  authenticator: "app",
  principalType: "runtime",
  attributes: {},
};

describe.skipIf(!hasDatabase)("a scheduled run acts for the schedule's creator", () => {
  const ledger = useLedger();
  let counter = 0;

  beforeEach(() => {
    runtime.sql = ledger.sql();
    vi.stubEnv("SYM_SLACK_USERS", "UCREATOR,UOTHER");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  // A run of a schedule that UCREATOR set up, attached to its own session.
  async function runSession(): Promise<string> {
    counter += 1;
    const sql = ledger.sql();
    const schedule = await createSchedule(
      sql,
      {
        cron: "0 9 * * *",
        title: `Support check ${counter}`,
        instruction: "Read #support and react to unanswered posts.",
        builder: "ask",
        channel: "C1",
        owner: "UCREATOR",
      },
      T0,
    );
    const due = new Date(T0.getTime() + counter * 60_000);
    const run = await reserveRun(sql, { scheduleId: schedule.id, dueAt: due, firedAt: due });
    if (!run) throw new Error("expected a run");
    const sessionId = `run-session-${counter}`;
    await attachSession(sql, run.id, sessionId);
    return sessionId;
  }
  const session = (id: string, current: Caller) => ({ id, auth: { current }, turn: { id: "t1" } });
  const deps = () => ({ sql: ledger.sql() });
  // biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
  const call = (tool: any, input: unknown, ctx: unknown) => tool.execute(input, ctx);

  it("is the creator for a run, the person for a person's turn, and nobody otherwise", async () => {
    const id = await runSession();
    expect(await requesterOf(session(id, APP), deps)).toBe("UCREATOR");
    expect(await requesterOf(session("chat", { principalId: "slack:T1:UOTHER" }), deps)).toBe(
      "UOTHER",
    );
    expect(await requesterOf(session(id, { principalId: "sym-worker" }), deps)).toBeUndefined();
    expect(await requesterOf(session("recovery", APP), deps)).toBeUndefined();
  });

  it("refuses for a creator who left the allow-list", async () => {
    const id = await runSession();
    vi.stubEnv("SYM_SLACK_USERS", "UOTHER");
    expect(await requesterOf(session(id, APP), deps)).toBeUndefined();
    const ctx = { session: session(id, APP), callId: "c1" };
    expect(await call(slackPost, { target: "C9", text: "Unanswered: 2 posts" }, ctx)).toBe(
      UNREACHABLE,
    );
    expect(vi.mocked(postToConversation).mock.calls[0]?.[1].requester).toBeUndefined();
  });

  it("passes the creator to slack_post and slack_react in a run", async () => {
    const id = await runSession();
    const ctx = { session: session(id, APP), callId: "c1" };
    await call(slackPost, { target: "C9", text: "Unanswered: 2 posts" }, ctx);
    expect(vi.mocked(postToConversation).mock.calls[0]?.[1].requester).toBe("UCREATOR");
    const link = "https://example.slack.com/archives/C9/p1700000000000100";
    expect(await call(slackReact, { emoji: "eyes", message: link }, ctx)).toBe("Reacted.");
    expect(vi.mocked(reactToLinkedMessage).mock.calls[0]?.[1]).toBe("UCREATOR");
  });

  it("lets only the creator approve a gated post in a run", async () => {
    const id = await runSession();
    const respond = requesterResponse("Only the person who asked can approve this post.", deps);
    const answer = (principalId: string, requester: { principalId: string } = APP) =>
      respond({
        request: { principal: requester },
        response: { principal: { principalId } },
        session: { id },
      });
    expect(await answer("slack:T1:UCREATOR")).toEqual({ status: "allowed" });
    expect((await answer("slack:T1:UOTHER")).status).toBe("rejected");
    // A person's own turn keeps the rule of decision 081.
    const person = { principalId: "slack:T1:UOTHER" };
    expect(await answer("slack:T1:UOTHER", person)).toEqual({ status: "allowed" });
    expect((await answer("slack:T1:UCREATOR", person)).status).toBe("rejected");
    // The tool's own policy is the same one.
    const policy = (slackPost as unknown as { approval: { response: typeof respond } }).approval
      .response;
    expect(
      await policy({
        request: { principal: APP },
        response: { principal: { principalId: "slack:T1:UCREATOR" } },
        session: { id },
      }),
    ).toEqual({ status: "allowed" });
  });

  it("ends a run with no job from what its turn posted, and leaves a run with a job alone", async () => {
    const sql = ledger.sql();
    const quiet = await runSession();
    const posted = await runSession();
    const failed = await runSession();
    const withJob = await runSession();
    await sql`
      insert into jobs (request_key, kind, title, brief, worker, session_id)
      values ('run-job', 'code-change', 't', '{}', 't3', ${withJob})
    `;
    await finishRunWithoutJob(sql, quiet, turnOutcome("completed", false));
    await finishRunWithoutJob(sql, posted, turnOutcome("completed", true));
    await finishRunWithoutJob(sql, failed, turnOutcome("failed", false));
    await finishRunWithoutJob(sql, withJob, turnOutcome("completed", false));
    // A later turn in the same thread does not change the first outcome.
    await finishRunWithoutJob(sql, quiet, turnOutcome("completed", true));
    const outcomes = new Map((await runsSince(sql, T0)).map((run) => [run.sessionId, run.outcome]));
    expect(outcomes.get(quiet)).toBe("all_clear");
    expect(outcomes.get(posted)).toBe("needs_attention");
    expect(outcomes.get(failed)).toBe("failed");
    expect(outcomes.get(withJob)).toBe("started");
  });
});
