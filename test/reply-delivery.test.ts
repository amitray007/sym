import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliver } from "../lib/delivery/deliver.ts";
import { queueReply } from "../lib/delivery/replies.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe.skipIf(!hasDatabase)("durable brain replies", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  const api = () =>
    slackApiFromEnv({ SLACK_BOT_TOKEN: "xoxb-fake", SLACK_API_BASE_URL: slack.apiBaseUrl });
  beforeAll(async () => {
    slack = await startFakeSlack({ botToken: "xoxb-fake" });
    slack.addMessage({ channel: "C1", user: "U1", ts: "1.1", text: "Question" });
    slack.addMessage({ channel: "C2", user: "U1", ts: "2.1", text: "Long question" });
  });
  afterAll(async () => {
    await slack?.close();
  });
  it("records a full reply with a display choice and delivers it once", async () => {
    const input = {
      key: "chat-reply",
      channel: "C1",
      threadTs: "1.1",
      text: "Tests did not run. PR #12 needs review.",
    };
    expect(await queueReply(ledger.sql(), api(), input)).toBe(true);
    expect(await queueReply(ledger.sql(), api(), input)).toBe(true);
    const [row] =
      await ledger.sql()`select display, status, payload from outbox where idempotency_key = 'chat-reply'`;
    expect(row).toMatchObject({
      display: { level: 1 },
      status: "sent",
      payload: { text: input.text },
    });
    expect(slack.messages.filter((m) => m.text === input.text)).toHaveLength(1);
    expect(JSON.stringify(slack.calls)).not.toContain("sym_thread_reply");
  });
  it("falls back to full text if Slack rejects the markdown block", async () => {
    slack.failNext("chat.postMessage", "invalid_blocks");
    const text = "The test failed. PR #12 is still open.";
    expect(
      await queueReply(ledger.sql(), api(), {
        key: "refused-markdown",
        channel: "C1",
        threadTs: "1.1",
        text,
      }),
    ).toBe(true);
    const post = slack.messages.find((m) => m.text === text);
    expect(post?.blocks).toBeUndefined();
    expect(post?.text).toBe(text);
  });
  it("uploads long replies through the outbox and retries failed completion", async () => {
    slack.failNext("files.completeUploadExternal", "internal_error");
    const summary = "Tests did not run. PR #12 needs review.";
    const text = `${summary}\n\n${"A long result. ".repeat(1000)}`;
    const input = { key: "long-reply", channel: "C2", threadTs: "2.1", text };
    expect(await queueReply(ledger.sql(), api(), input)).toBe(false);
    const report = await deliver(ledger.sql(), api());
    expect(
      report.sent,
      JSON.stringify(
        await ledger.sql()`select status, last_error, attempts from outbox where idempotency_key = 'long-reply'`,
      ),
    ).toBe(1);
    const posts = slack.messages.filter((m) => m.channel === "C2" && m.user !== "U1");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.files).toHaveLength(1);
    expect(posts[0]?.text).toBe(summary);
    expect(slack.uploads.at(-1)?.bytes).toBe(new TextEncoder().encode(text).length);
    expect(
      (await ledger.sql()`select payload from outbox where idempotency_key = 'long-reply'`)[0]
        ?.payload.text,
    ).toBe(text);
  });
  it("never turns a deleted thread into a top-level channel post", async () => {
    slack.failNext("chat.getPermalink", "message_not_found");
    const text = "Private reply for the deleted thread";
    expect(
      await queueReply(ledger.sql(), api(), {
        key: "deleted-thread",
        channel: "C3",
        threadTs: "3.1",
        text,
      }),
    ).toBe(false);
    expect(slack.messages.some((m) => m.text === text)).toBe(false);
    expect(
      (await ledger.sql()`select status from outbox where idempotency_key = 'deleted-thread'`)[0]
        ?.status,
    ).toBe("failed");
  });
});
