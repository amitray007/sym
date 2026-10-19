import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SlackApiError } from "../lib/slack/api.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";

let slack: FakeSlack;
const token = "xoxb-test-token";

const env = () => ({ SLACK_BOT_TOKEN: token, SLACK_API_BASE_URL: slack.apiBaseUrl });

beforeAll(async () => {
  slack = await startFakeSlack({ botToken: token });
});
afterAll(async () => {
  await slack.close();
});

describe("slackApiFromEnv", () => {
  it("posts a message with nested blocks and thread_ts", async () => {
    const api = slackApiFromEnv(env());
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
    const res = await api.call("chat.postMessage", {
      channel: "C1",
      thread_ts: "1.000001",
      text: "[hello] world",
      blocks,
    });
    expect(typeof res.ts).toBe("string");
    const stored = slack.messages.find((m) => m.ts === res.ts);
    expect(stored).toMatchObject({
      channel: "C1",
      thread_ts: "1.000001",
      text: "[hello] world",
      blocks,
    });
  });

  it("updates a stored message", async () => {
    const api = slackApiFromEnv(env());
    const posted = await api.call("chat.postMessage", { channel: "C2", text: "before" });
    await api.call("chat.update", { channel: "C2", ts: posted.ts, text: "after" });
    expect(slack.messages.find((m) => m.ts === posted.ts)?.text).toBe("after");
  });

  it("maps ok:false to SlackApiError with Slack's code", async () => {
    const api = slackApiFromEnv(env());
    const error = await api
      .call("chat.update", { channel: "C2", ts: "9.9", text: "x" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ method: "chat.update", code: "message_not_found" });
  });

  it("records unknown methods and reports unknown_method", async () => {
    const api = slackApiFromEnv(env());
    await expect(api.call("nope.nothing", {})).rejects.toMatchObject({ code: "unknown_method" });
    expect(slack.callsTo("nope.nothing")).toHaveLength(1);
  });

  it("reports invalid_auth for a bad token without leaking it", async () => {
    const api = slackApiFromEnv({ ...env(), SLACK_BOT_TOKEN: "xoxb-wrong" });
    const error = await api.call("auth.test", {}).catch((e) => e);
    expect(error).toMatchObject({ code: "invalid_auth" });
    expect(String(error.message)).not.toContain("xoxb-wrong");
  });

  it("throws when the token is missing", async () => {
    const api = slackApiFromEnv({ SLACK_API_BASE_URL: slack.apiBaseUrl });
    await expect(api.call("auth.test", {})).rejects.toThrow("SLACK_BOT_TOKEN");
  });
});

describe("fake Slack server", () => {
  it("serves replies, reactions, status, and JSON bodies", async () => {
    const api = slackApiFromEnv(env());
    const root = await api.call("chat.postMessage", { channel: "C3", text: "root" });
    await api.call("chat.postMessage", { channel: "C3", thread_ts: root.ts, text: "reply" });
    const replies = await api.call("conversations.replies", { channel: "C3", ts: root.ts });
    expect((replies.messages as { text: string }[]).map((m) => m.text)).toEqual(["root", "reply"]);

    await api.call("reactions.add", { channel: "C3", timestamp: root.ts, name: "eyes" });
    await expect(
      api.call("reactions.add", { channel: "C3", timestamp: root.ts, name: "eyes" }),
    ).rejects.toMatchObject({ code: "already_reacted" });
    await api.call("assistant.threads.setStatus", {
      channel_id: "C3",
      thread_ts: root.ts,
      status: "Thinking...",
    });
    expect(slack.statuses.at(-1)?.status).toBe("Thinking...");

    const response = await fetch(`${slack.apiBaseUrl}chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "C3", text: "json", blocks: [{ type: "divider" }] }),
    });
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
