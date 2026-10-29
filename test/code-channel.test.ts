import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobIdOfThread } from "../lib/feedback/feedback.ts";
import { createJob, getJob, updateJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import {
  archiveCodeChannel,
  codeChannelsOn,
  jobOfCodeChannel,
  moveToCodeChannel,
  pointToQuestion,
  setChannelStatus,
} from "../lib/slack/code-channel.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe("codeChannelsOn", () => {
  it("is off unless SYM_CODE_CHANNELS says on", () => {
    expect(codeChannelsOn({})).toBe(false);
    expect(codeChannelsOn({ SYM_CODE_CHANNELS: "off" })).toBe(false);
    expect(codeChannelsOn({ SYM_CODE_CHANNELS: "on" })).toBe(true);
    expect(codeChannelsOn({ SYM_CODE_CHANNELS: " TRUE " })).toBe(true);
  });
});

// The real SlackApi against the fake Slack server, so each call crosses HTTP as in production.
describe.skipIf(!hasDatabase)("job code channels", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  let api: ReturnType<typeof slackApiFromEnv>;
  let counter = 0;

  beforeAll(async () => {
    slack = await startFakeSlack({ channels: { CPRIV: { is_private: true } } });
    api = slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    });
  });
  afterAll(async () => {
    await slack.close();
    vi.unstubAllEnvs();
  });

  const newJob = async (channel = "C1") => {
    counter += 1;
    const sessionId = `session-${counter}`;
    const sql = ledger.sql();
    await recordSessionThread(sql, {
      sessionId,
      teamId: "T1",
      channelId: channel,
      threadTs: "1700000000.000100",
      userId: "U1",
    });
    await sql`
      update session_threads set message_ts = '1700000000.000200' where session_id = ${sessionId}
    `;
    return createJob(sql, {
      requestKey: `code-channel-${counter}`,
      sessionId,
      kind: "code-change",
      title: "Add retries",
      brief: { project: "example-app" },
      worker: "fake",
      slackChannel: channel,
      slackThreadTs: "1700000000.000100",
    });
  };

  it("stays in the thread when the feature is off", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "");
    const job = await newJob();
    const after = await moveToCodeChannel({ sql: ledger.sql(), slack: api }, job);
    expect(after.codeChannel).toBe(false);
    expect(slack.callsTo("agents.conversations.create")).toHaveLength(0);
  });

  it("moves a started job into a code channel from the person's message", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const sql = ledger.sql();
    const job = await newJob();
    const moved = await moveToCodeChannel({ sql, slack: api }, job);

    const channel = slack.codeChannels.at(-1);
    expect(channel?.originChannel).toBe("C1");
    expect(channel?.originTs).toBe("1700000000.000200");
    expect(moved).toMatchObject({
      slackChannel: channel?.id,
      slackThreadTs: null,
      codeChannel: true,
    });
    expect(channel?.contextBar).toEqual([
      { key: "job", label: `J-${job.id}`, icon: "code" },
      { key: "project", label: "example-app", icon: "folder" },
    ]);
    expect(channel?.statuses).toEqual(["processing"]);
    expect(moved).toMatchObject({ originChannel: "C1", originThreadTs: "1700000000.000100" });
    expect((await jobOfCodeChannel(sql, channel?.id ?? ""))?.id).toBe(job.id);
  });

  it("reaches the same channel when a step replays with the job as it was", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const sql = ledger.sql();
    const job = await newJob();
    const first = await moveToCodeChannel({ sql, slack: api }, job);
    // A replay before the ledger write was seen passes the unmoved job again.
    const replay = await moveToCodeChannel({ sql, slack: api }, job);
    expect(replay.slackChannel).toBe(first.slackChannel);
    expect(slack.codeChannels.filter((c) => c.sessionId === `sym-J-${job.id}`)).toHaveLength(1);
    expect((await getJob(sql, job.id))?.slackChannel).toBe(first.slackChannel);
  });

  it("opens a private channel for a private thread", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const moved = await moveToCodeChannel({ sql: ledger.sql(), slack: api }, await newJob("CPRIV"));
    const channel = slack.codeChannels.find((c) => c.id === moved.slackChannel);
    expect(channel?.isPrivate).toBe(true);
    expect(moved.codeChannel).toBe(true);
  });

  it("archives a public channel Slack opened for a private thread and stays put", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    slack.codeChannelsPublic = true;
    try {
      const job = await newJob("CPRIV");
      const after = await moveToCodeChannel({ sql: ledger.sql(), slack: api }, job);
      expect(after).toMatchObject({ slackChannel: "CPRIV", codeChannel: false });
      expect(slack.codeChannels.at(-1)).toMatchObject({ isPrivate: false, archived: true });
    } finally {
      slack.codeChannelsPublic = false;
      warn.mockRestore();
    }
  });

  it("adopts the code channel a job starts in instead of opening another", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const sql = ledger.sql();
    const outer = await moveToCodeChannel({ sql, slack: api }, await newJob());
    const before = slack.codeChannels.length;
    const inner = await moveToCodeChannel(
      { sql, slack: api },
      await newJob(outer.slackChannel ?? ""),
    );
    expect(inner).toMatchObject({
      codeChannel: true,
      slackChannel: outer.slackChannel,
      slackThreadTs: null,
      originChannel: null,
    });
    expect(slack.codeChannels).toHaveLength(before);
  });

  it("links a worker question to the thread where Eve asks it", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const sql = ledger.sql();
    const moved = await moveToCodeChannel({ sql, slack: api }, await newJob());
    await pointToQuestion({ sql, slack: api }, moved, "req-1", "Which environment?");
    await pointToQuestion({ sql, slack: api }, moved, "req-1", "Which environment?");
    const posts = await sql<{ payload: { channel: string; text: string } }[]>`
      select payload from outbox where job_id = ${moved.id} and idempotency_key like '%question-link%'
    `;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload.channel).toBe(moved.slackChannel);
    expect(posts[0]?.payload.text).toContain(`J-${moved.id} has a question: Which environment?`);
    expect(posts[0]?.payload.text).toContain("Answer it in the thread where it started.");
  });

  it("keeps a direct message job in place", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const before = slack.callsTo("agents.conversations.create").length;
    const job = await newJob("D1");
    const after = await moveToCodeChannel({ sql: ledger.sql(), slack: api }, job);
    expect(after.codeChannel).toBe(false);
    expect(slack.callsTo("agents.conversations.create")).toHaveLength(before);
  });

  it("keeps the job in its thread when Slack refuses", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    slack.failNext("agents.conversations.create", "feature_disabled");
    const job = await newJob();
    const after = await moveToCodeChannel({ sql: ledger.sql(), slack: api }, job);
    expect(after).toMatchObject({ slackChannel: "C1", codeChannel: false });
    expect(String(warn.mock.calls[0]?.[1])).toBe("feature_disabled");
    warn.mockRestore();
  });

  it("archives with the result as the summary, once", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const sql = ledger.sql();
    const moved = await moveToCodeChannel({ sql, slack: api }, await newJob());
    const done = await updateJob(sql, moved.id, {
      status: "done",
      prUrl: "https://example.com/pr/1",
    });
    const posted = await api.call("chat.postMessage", { channel: done.slackChannel, text: "Done" });
    const summaryTs = String(posted.ts);
    await setChannelStatus({ sql, slack: api }, done, "active");
    await archiveCodeChannel({ sql, slack: api }, done, summaryTs);
    await archiveCodeChannel({ sql, slack: api }, done, summaryTs);

    const channel = slack.codeChannels.find((c) => c.id === done.slackChannel);
    expect(channel).toMatchObject({ archived: true, summaryTs });
    expect(channel?.statuses).toEqual(["processing", "active", "closed", "closed"]);
  });

  it("archives without a summary when Slack cannot find it", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const sql = ledger.sql();
    const moved = await moveToCodeChannel({ sql, slack: api }, await newJob());
    await archiveCodeChannel({ sql, slack: api }, moved, "1700000000.999999");
    const channel = slack.codeChannels.find((c) => c.id === moved.slackChannel);
    expect(channel).toMatchObject({ archived: true, summaryTs: undefined });
  });

  it("finds a moved job from a button in the thread it left", async () => {
    vi.stubEnv("SYM_CODE_CHANNELS", "on");
    const sql = ledger.sql();
    const moved = await moveToCodeChannel({ sql, slack: api }, await newJob("CFEED"));
    expect(await jobIdOfThread(sql, "CFEED", "1700000000.000100")).toBe(moved.id);
    expect(await jobIdOfThread(sql, moved.slackChannel ?? "", "1700000000.123456")).toBe(moved.id);
  });

  it("does nothing for a job that stayed in its thread", async () => {
    const before = slack.calls.length;
    const job = await newJob();
    await setChannelStatus({ sql: ledger.sql(), slack: api }, job, "active");
    await archiveCodeChannel({ sql: ledger.sql(), slack: api }, job, null);
    expect(slack.calls).toHaveLength(before);
  });
});
