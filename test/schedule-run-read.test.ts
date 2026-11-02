import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionThread, recordSessionThread } from "../lib/ledger/threads.ts";
import { requesterOf, threadUserOf } from "../lib/requester.ts";
import { attachSession, createSchedule, reserveRun } from "../lib/schedules/rows.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { READ_ELSEWHERE, type ReadResult, readConversation } from "../lib/slack/read.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 085: a run's thread counts as its creator's own. A run that posts in the creator's DM
// can share what the creator may read there (decision 083); anyone else still cannot.

const APP = {
  principalId: "eve:app",
  authenticator: "app",
  principalType: "runtime",
  attributes: {},
};

describe.skipIf(!hasDatabase)("a scheduled run reads for its creator", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  let counter = 0;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: {
        G0PRIV: { name: "secret", is_private: true },
        DUASKER: { is_im: true },
        DUOTHER: { is_im: true },
      },
      members: { G0PRIV: ["UASKER", "UOTHER"] },
    });
  });
  afterAll(async () => slack.close());
  beforeEach(() => vi.stubEnv("SYM_SLACK_USERS", "UASKER,UOTHER"));
  afterEach(() => vi.unstubAllEnvs());

  const sqlDeps = () => ({ sql: ledger.sql() });
  const readDeps = () => ({
    sql: ledger.sql(),
    slack: slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    }),
    usersEnv: "UASKER,UOTHER",
  });

  // A run of a schedule `owner` set up to post in `channel`, as the turn.started handler records it.
  async function runIn(owner: string, channel: string): Promise<string> {
    counter += 1;
    const sql = ledger.sql();
    const schedule = await createSchedule(
      sql,
      {
        cron: "0 9 * * *",
        title: `Digest ${counter}`,
        instruction: "Summarize #secret for me.",
        builder: "ask",
        channel,
        owner,
      },
      new Date("2026-11-03T08:00:00Z"),
    );
    const due = new Date(Date.UTC(2026, 10, 3, 9, counter));
    const run = await reserveRun(sql, { scheduleId: schedule.id, dueAt: due, firedAt: due });
    if (!run) throw new Error("expected a run");
    const sessionId = `run-read-${counter}`;
    await attachSession(sql, run.id, sessionId);
    const session = { id: sessionId, auth: { current: APP } };
    await recordSessionThread(sql, {
      sessionId,
      teamId: "T1",
      channelId: channel,
      threadTs: null,
      userId: await threadUserOf(session, undefined, sqlDeps),
    });
    return sessionId;
  }

  it("records the creator as the run thread's person", async () => {
    const sessionId = await runIn("UASKER", "DUASKER");
    expect((await getSessionThread(ledger.sql(), sessionId))?.userId).toBe("UASKER");
  });

  it("reads a private channel the creator can read into the creator's DM", async () => {
    slack.addMessage({ channel: "G0PRIV", user: "UOTHER", text: "release slips a day" });
    const sessionId = await runIn("UASKER", "DUASKER");
    const requester = await requesterOf({ id: sessionId, auth: { current: APP } }, sqlDeps);
    expect(requester).toBe("UASKER");
    const read = (await readConversation(readDeps(), {
      sessionId,
      requester,
      target: "#secret",
    })) as ReadResult;
    expect(read.messages.map((m) => m.text)).toContain("release slips a day");
  });

  it("still refuses someone who is not the run's creator", async () => {
    const sessionId = await runIn("UOTHER", "DUOTHER");
    expect(
      await readConversation(readDeps(), { sessionId, requester: "UASKER", target: "#secret" }),
    ).toBe(READ_ELSEWHERE);
  });
});
