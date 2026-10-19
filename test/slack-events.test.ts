import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appMentionRequest,
  blockActionsRequest,
  directMessageRequest,
  signSlackRequest,
} from "./helpers/slack-events.ts";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";

describe("signSlackRequest", () => {
  it("matches a vector computed with openssl", () => {
    // printf 'v0:1700000000:{"a":1}' | openssl dgst -sha256 -hmac s3cret
    const headers = signSlackRequest('{"a":1}', "s3cret", 1700000000);
    expect(headers["x-slack-signature"]).toBe(
      "v0=bd185b05da99402f371e04f620aeca81515f08c0ef7fcf979fccaa4d2f87d47c",
    );
    expect(headers["x-slack-request-timestamp"]).toBe("1700000000");
  });

  it("matches an independently computed HMAC", () => {
    const expected = createHmac("sha256", "s3cret").update("v0:1700000000:{}").digest("hex");
    expect(signSlackRequest("{}", "s3cret", 1700000000)["x-slack-signature"]).toBe(
      `v0=${expected}`,
    );
  });
});

describe("event builders", () => {
  const base = { signingSecret: secret, channel: "C1", user: "U1", ts: "1.000001" };

  function verifies(parts: { body: string; headers: Record<string, string> }) {
    const ts = parts.headers["x-slack-request-timestamp"] as string;
    const digest = createHmac("sha256", secret).update(`v0:${ts}:${parts.body}`).digest("hex");
    return parts.headers["x-slack-signature"] === `v0=${digest}`;
  }

  it("builds a signed app_mention", () => {
    const parts = appMentionRequest({ ...base, text: "<@UBOT> hi", threadTs: "1.000000" });
    const json = JSON.parse(parts.body);
    expect(json).toMatchObject({
      type: "event_callback",
      event: { type: "app_mention", channel: "C1", thread_ts: "1.000000" },
    });
    expect(verifies(parts)).toBe(true);
  });

  it("builds a signed direct message", () => {
    const parts = directMessageRequest({ ...base, channel: "D1", text: "hi" });
    expect(JSON.parse(parts.body).event).toMatchObject({ type: "message", channel_type: "im" });
    expect(verifies(parts)).toBe(true);
  });

  it("builds a signed block_actions payload, form-encoded", () => {
    const parts = blockActionsRequest({
      ...base,
      messageTs: "1.000002",
      actionId: "approve",
      value: "j1",
    });
    expect(parts.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const payload = JSON.parse(new URLSearchParams(parts.body).get("payload") as string);
    expect(payload).toMatchObject({
      type: "block_actions",
      actions: [{ action_id: "approve", value: "j1" }],
    });
    expect(verifies(parts)).toBe(true);
  });
});
