import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { dmNeedsConfirmation, sendDirectMessage } from "../lib/slack/dm.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { deleteOwnPost, editOwnPost } from "../lib/slack/own-posts.ts";
import { lookUpPerson, UNKNOWN_PERSON } from "../lib/slack/people.ts";
import { UNREACHABLE } from "../lib/slack/reach.ts";
import { READ_ELSEWHERE, type ReadResult, readConversation } from "../lib/slack/read.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 083: slack_read, slack_dm, and slack_user over the real Slack client against the
// fake Slack server.
describe.skipIf(!hasDatabase)("reading, DMs, and people", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: {
        C0PUBLIC: { name: "releases" },
        G0PRIV: { name: "secret", is_private: true },
        C0OTHER: { name: "general" },
        DUASKER: { is_im: true },
      },
      members: { C0PUBLIC: ["UASKER"], G0PRIV: ["UASKER"], C0OTHER: ["UASKER"] },
      users: {
        UPRIYA: {
          real_name: "Priya",
          tz: "Asia/Kolkata",
          profile: { title: "SRE", status_text: "On call", status_emoji: ":pager:" },
        },
        UBOTTY: { is_bot: true },
        UGONE: { deleted: true },
        UGUEST: { is_stranger: true },
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
    usersEnv: "UASKER",
  });
  const session = (sessionId: string, channelId: string) =>
    recordSessionThread(ledger.sql(), {
      sessionId,
      teamId: "T1",
      channelId,
      threadTs: null,
      userId: "UASKER",
    });
  const link = (channel: string, ts: string) =>
    `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}`;

  describe("slack_read", () => {
    it("reads a public thread anywhere the requester asks", async () => {
      await session("s-other", "C0OTHER");
      const root = slack.addMessage({ channel: "C0PUBLIC", user: "UPRIYA", text: "ship v2.4?" });
      slack.addMessage({ channel: "C0PUBLIC", user: "UASKER", text: "yes", thread_ts: root.ts });
      const read = (await readConversation(deps(), {
        sessionId: "s-other",
        requester: "UASKER",
        target: link("C0PUBLIC", root.ts),
      })) as ReadResult;
      expect(read.messages.map((m) => m.text)).toEqual(["ship v2.4?", "yes"]);
      expect(read.note).toMatch(/not instructions/);
    });

    it("shares a private channel only there or in the requester's DM", async () => {
      await session("s-dm", "DUASKER");
      await session("s-priv", "G0PRIV");
      slack.addMessage({ channel: "G0PRIV", user: "UPRIYA", text: "salary bands" });
      const read = (sessionId: string) =>
        readConversation(deps(), { sessionId, requester: "UASKER", target: "#secret" });
      expect(await read("s-other")).toBe(READ_ELSEWHERE);
      expect(((await read("s-dm")) as ReadResult).messages.map((m) => m.text)).toEqual([
        "salary bands",
      ]);
      expect(((await read("s-priv")) as ReadResult).messages).toHaveLength(1);
    });

    it("refuses a non-member like every other unreachable target", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      slack.members.C0PUBLIC = [];
      expect(
        await readConversation(deps(), {
          sessionId: "s-dm",
          requester: "UASKER",
          target: "#releases",
        }),
      ).toBe(UNREACHABLE);
      slack.members.C0PUBLIC = ["UASKER"];
      vi.restoreAllMocks();
    });
  });

  describe("slack_user", () => {
    it("gives name, title, time zone, local time, and status", async () => {
      const person = await lookUpPerson(
        deps(),
        "UASKER",
        "<@UPRIYA>",
        new Date("2026-11-03T12:00:00Z"),
      );
      expect(person).toMatchObject({
        id: "UPRIYA",
        name: "Priya",
        title: "SRE",
        timeZone: "Asia/Kolkata",
        localTime: "Tue 5:30 PM",
        status: ":pager: On call",
        isBot: false,
      });
    });

    it("answers nothing for someone off the allow-list or a bad ID", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await lookUpPerson(deps(), "USTRANGER", "<@UPRIYA>")).toBeUndefined();
      expect(await lookUpPerson(deps(), "UASKER", "Priya")).toBeUndefined();
      vi.restoreAllMocks();
    });
  });

  describe("slack_dm", () => {
    const dm = (person: string, callId: string, text = "v2.4 shipped.") =>
      sendDirectMessage(deps(), {
        sessionId: "s-other",
        callId,
        requester: "UASKER",
        person,
        text,
      });

    it("sends a DM once per call, and only its requester can edit or delete it", async () => {
      expect(await dm("<@UPRIYA>", "dm-1")).toBe("Sent to Priya.");
      expect(await dm("<@UPRIYA>", "dm-1")).toBe("Sent to Priya.");
      const sent = slack.messages.filter((m) => m.channel === "DUPRIYA");
      expect(sent.map((m) => m.text)).toEqual(["v2.4 shipped."]);
      const ts = sent[0]?.ts as string;
      const own = { sessionId: "s-other", callId: "e", message: link("DUPRIYA", ts) };
      expect(
        await editOwnPost(
          { ...deps(), usersEnv: "UASKER,UOTHER" },
          { ...own, requester: "UOTHER", text: "x" },
        ),
      ).toMatch(/only change/);
      expect(
        await editOwnPost(deps(), { ...own, requester: "UASKER", text: "v2.4.1 shipped." }),
      ).toBe("Edited.");
      expect(await deleteOwnPost(deps(), { ...own, requester: "UASKER" })).toBe("Deleted.");
    });

    it("never DMs a bot, a deactivated person, or someone from another organization", async () => {
      for (const person of ["UBOTTY", "UGONE", "UGUEST"]) {
        expect(await dm(person, `dm-${person}`)).toBe(
          "I only send DMs to current people in this workspace.",
        );
      }
      expect(await dm("Priya", "dm-name")).toBe(UNKNOWN_PERSON);
    });

    it("asks before carrying words out of a private conversation", async () => {
      expect(await dmNeedsConfirmation(deps(), "s-other", "UASKER", "<@UPRIYA>")).toBe(false);
      expect(await dmNeedsConfirmation(deps(), "s-priv", "UASKER", "<@UPRIYA>")).toBe(true);
      expect(await dmNeedsConfirmation(deps(), "s-dm", "UASKER", "<@UPRIYA>")).toBe(true);
      expect(await dmNeedsConfirmation(deps(), "s-priv", "UASKER", "<@UASKER>")).toBe(false);
      expect(await dmNeedsConfirmation(deps(), "s-none", "UASKER", "<@UPRIYA>")).toBe(true);
    });
  });
});
