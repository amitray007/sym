import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deliverNow } from "../lib/jobs/run.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { reactToLinkedMessage, unreactToTurn } from "../lib/reactions/react.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import {
  deleteOwnPost,
  editOwnPost,
  NOT_YOURS,
  OVER_CAP,
  POSTS_PER_HOUR,
  reservePost,
} from "../lib/slack/own-posts.ts";
import { UNREACHABLE } from "../lib/slack/reach.ts";
import { postToConversation } from "../lib/slack/slack-post.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 082: only the person who asked for a post can edit or delete it, posts are capped
// per person per hour, and reactions on linked messages follow the same membership rule.
describe.skipIf(!hasDatabase)("posts made on request", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: { C0RELEASE: { name: "releases" }, C0OPS: { name: "ops" } },
      members: { C0RELEASE: ["UASKER", "UOTHER"], C0OPS: ["UOTHER"] },
    });
  });
  afterAll(async () => slack.close());
  const deps = () => ({
    sql: ledger.sql(),
    slack: slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    }),
    usersEnv: "UASKER,UOTHER,UCAP",
  });
  const link = (channel: string, ts: string) =>
    `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  let call = 0;
  const post = async (requester: string, sessionId = "s-1", text = "v2.4 is out.") => {
    call += 1;
    expect(
      await postToConversation(deps(), {
        sessionId,
        callId: `call-${call}`,
        requester,
        target: "#releases",
        text,
      }),
    ).toBe("Posted.");
    return slack.messages.at(-1)?.ts as string;
  };
  const textOf = (ts: string) => slack.messages.find((m) => m.ts === ts)?.text;

  it("edits a post only for the person who asked, by link or as their latest", async () => {
    const ts = await post("UASKER");
    const edit = (requester: string, text: string, message?: string) =>
      editOwnPost(deps(), { sessionId: "s-1", callId: `edit-${text}`, requester, message, text });
    expect(await edit("UOTHER", "hijack", link("C0RELEASE", ts))).toBe(NOT_YOURS);
    expect(await edit("UASKER", "v2.4.1 is out.", link("C0RELEASE", ts))).toBe("Edited.");
    expect(textOf(ts)).toBe("v2.4.1 is out.");
    expect(await edit("UASKER", "v2.4.2 is out.")).toBe("Edited.");
    expect(textOf(ts)).toBe("v2.4.2 is out.");
  });

  it("deletes a post only for the person who asked, once", async () => {
    const ts = await post("UASKER");
    const remove = (requester: string) =>
      deleteOwnPost(deps(), {
        sessionId: "s-1",
        callId: "delete",
        requester,
        message: link("C0RELEASE", ts),
      });
    expect(await remove("UOTHER")).toBe(NOT_YOURS);
    expect(textOf(ts)).toBe("v2.4 is out.");
    expect(await remove("UASKER")).toBe("Deleted.");
    expect(textOf(ts)).toBeUndefined();
    expect(await remove("UASKER")).toBe(NOT_YOURS);
  });

  it("refuses an edit once the requester has left the channel", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ts = await post("UOTHER", "s-2");
    const members = slack.members.C0RELEASE as string[];
    slack.members.C0RELEASE = members.filter((m) => m !== "UOTHER");
    expect(
      await editOwnPost(deps(), {
        sessionId: "s-2",
        callId: "left",
        requester: "UOTHER",
        message: link("C0RELEASE", ts),
        text: "changed",
      }),
    ).toBe(UNREACHABLE);
    slack.members.C0RELEASE = members;
    vi.restoreAllMocks();
  });

  it(`caps each person at ${POSTS_PER_HOUR} posts an hour`, async () => {
    (slack.members.C0RELEASE as string[]).push("UCAP");
    for (let i = 0; i < POSTS_PER_HOUR; i += 1) await post("UCAP", "s-cap");
    const before = slack.messages.length;
    expect(
      await postToConversation(deps(), {
        sessionId: "s-cap",
        callId: "over",
        requester: "UCAP",
        target: "#releases",
        text: "one more",
      }),
    ).toBe(OVER_CAP);
    expect(slack.messages.length).toBe(before);
  });

  it("counts parallel posts against the cap", async () => {
    const reserve = (i: number) =>
      reservePost(ledger.sql(), {
        key: `race-${i}`,
        channelId: "C0RELEASE",
        requester: "URACE",
        sessionId: "s-race",
      });
    const claims = await Promise.all(
      Array.from({ length: POSTS_PER_HOUR + 5 }, (_, i) => reserve(i)),
    );
    expect(claims.filter(Boolean)).toHaveLength(POSTS_PER_HOUR);
    expect(await reserve(0)).toBe(true);
  });

  it("can edit a post that was pending when the tool returned", async () => {
    slack.failNext("chat.postMessage", "ratelimited");
    expect(
      await postToConversation(deps(), {
        sessionId: "s-late",
        callId: "late",
        requester: "UASKER",
        target: "#releases",
        text: "late news",
      }),
    ).toBe("The post will appear once Slack accepts it.");
    await deliverNow(deps());
    const late = slack.messages.find((m) => m.text === "late news");
    expect(late).toBeDefined();
    expect(
      await editOwnPost(deps(), {
        sessionId: "s-late",
        callId: "late-edit",
        requester: "UASKER",
        text: "later news",
      }),
    ).toBe("Edited.");
    expect(textOf(late?.ts ?? "")).toBe("later news");
  });

  it("adds and removes a reaction on a linked message for a member", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = slack.addMessage({ channel: "C0RELEASE", user: "UOTHER", text: "shipped" });
    const react = (requester: string, target: string, add: boolean) =>
      reactToLinkedMessage(
        { sql: ledger.sql(), api: deps().slack, usersEnv: "UASKER,UOTHER" },
        requester,
        target,
        "tada",
        add,
      );
    const here = link("C0RELEASE", message.ts);
    expect(await react("UASKER", here, true)).toBe("Reacted with :tada:.");
    expect(slack.reactions).toContainEqual({
      channel: "C0RELEASE",
      timestamp: message.ts,
      name: "tada",
    });
    expect(await react("UASKER", here, false)).toBe("Removed :tada:.");
    expect(await react("UASKER", here, false)).toBe("No :tada: of mine there.");
    const ops = slack.addMessage({ channel: "C0OPS", user: "UOTHER", text: "deploy" });
    expect(await react("UASKER", link("C0OPS", ops.ts), true)).toBe(UNREACHABLE);
    expect(await react("UASKER", "https://acme.slack.com/archives/C0RELEASE", true)).toBe(
      "Give me a link to the message.",
    );
    vi.restoreAllMocks();
  });

  it("takes its reaction off the message that started the turn", async () => {
    const message = slack.addMessage({ channel: "C0RELEASE", user: "UASKER", text: "thanks!" });
    await recordSessionThread(ledger.sql(), {
      sessionId: "s-turn",
      teamId: "T1",
      channelId: "C0RELEASE",
      threadTs: message.ts,
      userId: "UASKER",
    });
    await deps().slack.call("reactions.add", {
      channel: "C0RELEASE",
      timestamp: message.ts,
      name: "pray",
    });
    const deps2 = { sql: ledger.sql(), api: deps().slack, messageTs: message.ts };
    expect(await unreactToTurn(deps2, "s-turn", "pray")).toBe("Removed :pray:.");
    expect(slack.reactions.some((r) => r.timestamp === message.ts)).toBe(false);
  });
});
