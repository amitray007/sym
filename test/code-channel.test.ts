import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createJob, getJob, updateJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import {
  archiveCodeChannel,
  codeChannelsOn,
  jobOfCodeChannel,
  moveToCodeChannel,
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
    slack = await startFakeSlack();
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
    expect((await jobOfCodeChannel(sql, channel?.id ?? ""))?.id).toBe(job.id);

    // A retried move reaches the same channel and changes nothing.
    const again = await moveToCodeChannel({ sql, slack: api }, (await getJob(sql, job.id)) ?? job);
    expect(again.slackChannel).toBe(moved.slackChannel);
    expect(slack.codeChannels.filter((c) => c.id === moved.slackChannel)).toHaveLength(1);
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
    await setChannelStatus({ sql, slack: api }, done, "active");
    await archiveCodeChannel({ sql, slack: api }, done, "1700000000.000900");
    await archiveCodeChannel({ sql, slack: api }, done, "1700000000.000900");

    const channel = slack.codeChannels.find((c) => c.id === done.slackChannel);
    expect(channel).toMatchObject({ archived: true, summaryTs: "1700000000.000900" });
    expect(channel?.statuses).toEqual(["processing", "active", "closed", "closed"]);
  });

  it("does nothing for a job that stayed in its thread", async () => {
    const before = slack.calls.length;
    const job = await newJob();
    await setChannelStatus({ sql: ledger.sql(), slack: api }, job, "active");
    await archiveCodeChannel({ sql: ledger.sql(), slack: api }, job, null);
    expect(slack.calls).toHaveLength(before);
  });
});
