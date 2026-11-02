import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import slackPost from "../agent/tools/slack_post.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { UNREACHABLE } from "../lib/slack/reach.ts";
import { postNeedsConfirmation, postToConversation } from "../lib/slack/slack-post.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 081: slack_post over the real Slack client against the fake Slack server.
describe.skipIf(!hasDatabase)("slack_post", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: {
        C0SOURCE: { name: "general" },
        C0RELEASE: { name: "releases" },
        G0PRIV: { name: "secret", is_private: true },
        G0GROUP: { is_private: true, is_mpim: true },
        C0SHARED: { name: "partner", is_ext_shared: true },
      },
      members: {
        C0RELEASE: ["UASKER"],
        G0PRIV: ["UOTHER"],
        C0SOURCE: ["UASKER"],
        G0GROUP: ["UASKER", "UOTHER"],
      },
    });
  });
  afterAll(async () => slack.close());
  const deps = () => ({
    sql: ledger.sql(),
    slack: slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    }),
    usersEnv: "UASKER,UOTHER",
  });
  const post = (target: string, callId: string, requester = "UASKER") =>
    postToConversation(deps(), {
      sessionId: "s-1",
      callId,
      requester,
      target,
      text: "v2.4 is out.",
    });
  const postedIn = (channel: string) => slack.messages.filter((m) => m.channel === channel);

  it("posts at the top level of a #channel once per call, in Sym's voice, and records who asked", async () => {
    expect(await post("#releases", "call-1")).toBe("Posted.");
    expect(await post("#releases", "call-1")).toBe("Posted.");
    const posted = postedIn("C0RELEASE");
    expect(posted.map((m) => [m.text, m.thread_ts])).toEqual([["v2.4 is out.", undefined]]);
    const rows = await ledger.sql()<{ requester: string }[]>`
      select requester from requested_posts where message_ts = ${posted[0]?.ts ?? ""}
    `;
    expect(rows.map((row) => row.requester)).toEqual(["UASKER"]);
  });

  it("posts in the thread of a linked message", async () => {
    const root = slack.addMessage({ channel: "C0RELEASE", user: "UOTHER", text: "ship date?" });
    const link = `https://acme.slack.com/archives/C0RELEASE/p${root.ts.replace(".", "")}`;
    expect(await post(link, "call-2")).toBe("Posted.");
    expect(postedIn("C0RELEASE").at(-1)?.thread_ts).toBe(root.ts);
  });

  it("gives one refusal for every reason it can't reach", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = slack.messages.length;
    expect(await post("#secret", "call-3")).toBe(UNREACHABLE);
    expect(await post("<#G0PRIV|secret>", "call-4")).toBe(UNREACHABLE);
    expect(await post("#nowhere", "call-5")).toBe(UNREACHABLE);
    expect(await post("DUASKER", "call-6")).toBe(UNREACHABLE);
    expect(await post("G0GROUP", "call-8")).toBe(UNREACHABLE);
    expect(await post("#releases", "call-7", "USTRANGER")).toBe(UNREACHABLE);
    expect(slack.messages.length).toBe(before);
    vi.restoreAllMocks();
  });

  it("asks before carrying words out of a private conversation", async () => {
    const sql = ledger.sql();
    const thread = (sessionId: string, channelId: string) =>
      recordSessionThread(sql, {
        sessionId,
        teamId: "T1",
        channelId,
        threadTs: null,
        userId: "UASKER",
      });
    await thread("s-public", "C0SOURCE");
    await thread("s-private", "G0PRIV");
    await thread("s-dm", "DUASKER");
    const ask = (sessionId: string, target: string, text = "v2.4 is out.") =>
      postNeedsConfirmation(deps(), sessionId, target, text);
    expect(await ask("s-public", "#releases")).toBe(false);
    expect(await ask("s-private", "#releases")).toBe(true);
    expect(await ask("s-dm", "#releases")).toBe(true);
    expect(await ask("s-private", "<#G0PRIV|secret>")).toBe(false);
    expect(await ask("s-unknown", "#releases")).toBe(true);
  });

  // Decision 082: a broadcast ping or a Slack Connect channel always needs approval.
  it("asks before pinging a whole channel or posting to another organization", async () => {
    await recordSessionThread(ledger.sql(), {
      sessionId: "s-open",
      teamId: "T1",
      channelId: "C0SOURCE",
      threadTs: null,
      userId: "UASKER",
    });
    const ask = (target: string, text: string) =>
      postNeedsConfirmation(deps(), "s-open", target, text);
    expect(await ask("#releases", "<!here> v2.4 is out")).toBe(true);
    expect(await ask("#releases", "@channel v2.4 is out")).toBe(true);
    expect(await ask("#releases", "<!subteam^S123> heads up")).toBe(true);
    expect(await ask("<#C0SOURCE|general>", "<!channel> v2.4")).toBe(true);
    expect(await ask("C0SHARED", "v2.4 is out")).toBe(true);
    expect(await ask("#releases", "mail me at a@here.com")).toBe(false);
  });
});

describe("slack_post approval", () => {
  const approval = slackPost.approval as {
    response: (ctx: unknown) => { status: string };
  };
  const answer = (requester: string | null, responder: string) =>
    approval.response({
      request: { principal: requester ? { principalId: requester } : null },
      response: { decision: "approve", principal: { principalId: responder } },
    }).status;

  it("lets only the person who asked approve the post", () => {
    expect(answer("slack:T1:UASKER", "slack:T1:UASKER")).toBe("allowed");
    expect(answer("slack:T1:UASKER", "slack:T1:UOWNER")).toBe("rejected");
    expect(answer(null, "slack:T1:UASKER")).toBe("rejected");
  });
});
