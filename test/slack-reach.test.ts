import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import {
  isPrivateConversation,
  parseSlackTarget,
  reachConversation,
  resolveTarget,
} from "../lib/slack/reach.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";

// Decision 081: Sym acts in another conversation only for an allowed person who is a member,
// in a conversation Sym belongs to.
describe("parseSlackTarget", () => {
  it("reads a message link, with and without a thread", () => {
    expect(parseSlackTarget("https://acme.slack.com/archives/C0123ABC/p1730000000123456")).toEqual({
      channel: "C0123ABC",
      messageTs: "1730000000.123456",
    });
    expect(
      parseSlackTarget(
        "<https://acme.slack.com/archives/C0123ABC/p1730000000999999?thread_ts=1730000000.123456&cid=C0123ABC>",
      ),
    ).toEqual({
      channel: "C0123ABC",
      messageTs: "1730000000.999999",
      threadTs: "1730000000.123456",
    });
  });

  it("reads a channel link, a channel mention, and a channel ID", () => {
    expect(parseSlackTarget("https://acme.slack.com/archives/G0PRIV")).toEqual({
      channel: "G0PRIV",
    });
    expect(parseSlackTarget("<#C0RELEASE|releases>")).toEqual({ channel: "C0RELEASE" });
    expect(parseSlackTarget("C0RELEASE")).toEqual({ channel: "C0RELEASE" });
  });

  it("reads a labeled link and Sym's own app_redirect thread link", () => {
    expect(
      parseSlackTarget("<https://acme.slack.com/archives/C0123ABC/p1730000000123456|that message>"),
    ).toEqual({ channel: "C0123ABC", messageTs: "1730000000.123456" });
    expect(
      parseSlackTarget(
        "https://slack.com/app_redirect?channel=C0123ABC&message_ts=1730000000.123456",
      ),
    ).toEqual({ channel: "C0123ABC", messageTs: "1730000000.123456" });
    expect(parseSlackTarget("https://slack.com/app_redirect?channel=C0123ABC")).toEqual({
      channel: "C0123ABC",
    });
  });

  it("rejects links outside Slack and plain names", () => {
    expect(parseSlackTarget("https://evil.example/archives/C0123ABC")).toBeUndefined();
    expect(parseSlackTarget("http://acme.slack.com/archives/C0123ABC")).toBeUndefined();
    expect(parseSlackTarget("#releases")).toBeUndefined();
  });
});

describe("reaching a conversation", () => {
  let slack: FakeSlack;
  let api: ReturnType<typeof slackApiFromEnv>;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: {
        C0RELEASE: { name: "releases" },
        C0OUTSIDE: { name: "outside", is_member: false },
        G0PRIV: { name: "secret", is_private: true },
        C0OLD: { name: "old", is_archived: true },
      },
      members: {
        C0RELEASE: ["UASKER", "UOTHER"],
        C0OUTSIDE: ["UASKER"],
        G0PRIV: ["UOTHER"],
        C0OLD: ["UASKER"],
      },
    });
    api = slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    });
  });
  afterAll(async () => slack.close());
  const deps = () => ({ slack: api, usersEnv: "UASKER,UOTHER" });

  it("finds a #name among the channels Sym is in", async () => {
    expect(await resolveTarget(api, "#releases")).toEqual({ channel: "C0RELEASE" });
    expect(await resolveTarget(api, "releases")).toEqual({ channel: "C0RELEASE" });
    expect(await resolveTarget(api, "#outside")).toBeUndefined();
  });

  it("reaches a channel where Sym and the requester are both members", async () => {
    expect(await reachConversation(deps(), "UASKER", "C0RELEASE")).toEqual({
      id: "C0RELEASE",
      isPrivate: false,
      isDirect: false,
    });
  });

  it("refuses when either is not a member, the channel is archived, or Slack fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await reachConversation(deps(), "UASKER", "C0OUTSIDE")).toBeUndefined();
    expect(await reachConversation(deps(), "UASKER", "G0PRIV")).toBeUndefined();
    expect(await reachConversation(deps(), "UASKER", "C0OLD")).toBeUndefined();
    slack.failNext("conversations.info", "channel_not_found");
    expect(await reachConversation(deps(), "UASKER", "C0RELEASE")).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("refuses a requester off the allow-list, even a member", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await reachConversation({ slack: api, usersEnv: "UOTHER" }, "UASKER", "C0RELEASE"),
    ).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("treats DMs, private channels, and unknowns as private", async () => {
    expect(await isPrivateConversation(api, "C0RELEASE")).toBe(false);
    expect(await isPrivateConversation(api, "G0PRIV")).toBe(true);
    expect(await isPrivateConversation(api, "DUASKER")).toBe(true);
    slack.failNext("conversations.info", "channel_not_found");
    expect(await isPrivateConversation(api, "C0RELEASE")).toBe(true);
  });
});
