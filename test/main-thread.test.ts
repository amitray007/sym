import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJob, updateJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { postToMainThread, recordChannelOrigin } from "../lib/slack/main-thread.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 079: a code channel posts in its main thread when a person asks, over the real Slack
// client against the fake Slack server.
describe.skipIf(!hasDatabase)("main thread posts", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  beforeAll(async () => {
    slack = await startFakeSlack();
  });
  afterAll(async () => {
    await slack.close();
  });
  const deps = () => ({
    sql: ledger.sql(),
    slack: slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    }),
  });
  const inThread = (channel: string, ts: string) =>
    slack.messages.filter((m) => m.channel === channel && m.thread_ts === ts);

  it("posts in a job channel's origin thread once per call", async () => {
    const sql = ledger.sql();
    const root = slack.addMessage({ channel: "C1", user: "U1", text: "why are images stale?" });
    const job = await createJob(sql, {
      requestKey: "main-1",
      title: "Image sync",
      brief: { project: "test-repo", title: "Image sync", goal: "g", doneWhen: ["d"] },
      kind: "code-change",
      worker: "fake",
      slackChannel: "CCODE1",
    });
    await updateJob(sql, job.id, {
      codeChannel: true,
      originChannel: "C1",
      originThreadTs: root.ts,
      status: "done",
    });
    await recordSessionThread(sql, {
      sessionId: "s-job",
      teamId: "T1",
      channelId: "CCODE1",
      threadTs: null,
      userId: "U1",
    });
    const post = {
      sessionId: "s-job",
      callId: "call-1",
      text: "Found it: variants skip the sync.",
    };
    expect(await postToMainThread(deps(), post)).toBe("Posted in the main thread.");
    expect(await postToMainThread(deps(), post)).toBe("Posted in the main thread.");
    expect(inThread("C1", root.ts).map((m) => m.text)).toEqual([
      "Found it: variants skip the sync.",
    ]);
  });

  it("posts in a conversation channel's recorded origin", async () => {
    const root = slack.addMessage({ channel: "C2", user: "U1", text: "retry cap?" });
    await recordChannelOrigin(ledger.sql(), "s-conv", { channel: "C2", threadTs: root.ts });
    const answer = await postToMainThread(deps(), {
      sessionId: "s-conv",
      callId: "call-1",
      text: "We settled on the retry cap.",
    });
    expect(answer).toBe("Posted in the main thread.");
    expect(inThread("C2", root.ts).map((m) => m.text)).toEqual(["We settled on the retry cap."]);
  });

  it("says so when the conversation has no main thread", async () => {
    expect(
      await postToMainThread(deps(), { sessionId: "s-none", callId: "c", text: "hello" }),
    ).toBe("This conversation has no main thread to post in. Reply here instead.");
  });
});
