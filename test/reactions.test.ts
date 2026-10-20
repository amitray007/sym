import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import slackEmoji from "../agent/tools/slack_emoji.ts";
import slackReact from "../agent/tools/slack_react.ts";
import { NOT_FOR_WORKERS, WORKER_PRINCIPAL } from "../lib/callers.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { createEmojiCache, EMOJI_TTL_MS, normalizeEmoji } from "../lib/reactions/emoji.ts";
import {
  reactToTurn,
  recordTurnMessage,
  THREAD_CAP,
  THREAD_WINDOW_MS,
} from "../lib/reactions/react.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

let slack: FakeSlack;
const api = () =>
  slackApiFromEnv({ SLACK_BOT_TOKEN: "xoxb-fake-token", SLACK_API_BASE_URL: slack.apiBaseUrl });

beforeAll(async () => {
  slack = await startFakeSlack({ botToken: "xoxb-fake-token" });
});
afterAll(async () => {
  await slack.close();
});

describe("normalizeEmoji", () => {
  it.each([
    ["tada", "tada"],
    [":tada:", "tada"],
    ["  :Tada: ", "tada"],
    ["+1", "+1"],
    ["🎉", "tada"],
    ["👍", "+1"],
    ["❤️", "heart"],
    ["🫡", "saluting_face"],
  ])("reads %s as %s", (input, name) => {
    expect(normalizeEmoji(input)).toEqual({ ok: true, name });
  });

  it("rejects eyes in any form", () => {
    for (const input of ["eyes", ":eyes:", "👀"]) {
      expect(normalizeEmoji(input)).toMatchObject({ ok: false });
    }
  });

  it("rejects an unknown unicode emoji and a bad name with a hint", () => {
    expect(normalizeEmoji("🦤")).toMatchObject({
      ok: false,
      message: expect.stringContaining("name"),
    });
    expect(normalizeEmoji("two words")).toMatchObject({ ok: false });
    expect(normalizeEmoji("::")).toMatchObject({ ok: false });
  });
});

describe("custom emoji cache", () => {
  it("lists once within the hour, then again after it, and keeps aliases", async () => {
    Object.assign(slack.customEmoji, {
      party_parrot: "https://emoji.example/parrot.gif",
      shipit: "alias:rocket",
      facepalm_cat: "https://emoji.example/cat.png",
    });
    let clock = 1_000;
    const cache = createEmojiCache(api(), () => clock);
    const before = slack.callsTo("emoji.list").length;
    expect((await cache.list()).names).toEqual(["facepalm_cat", "party_parrot", "shipit"]);
    clock += EMOJI_TTL_MS - 1;
    await cache.list();
    expect(slack.callsTo("emoji.list").length - before).toBe(1);
    clock += 2;
    await cache.list();
    expect(slack.callsTo("emoji.list").length - before).toBe(2);
  });

  it("searches by substring, best prefix first, at most 20", async () => {
    const names: Record<string, string> = {};
    for (let i = 0; i < 30; i++) names[`zz_wave_${String(i).padStart(2, "0")}`] = "x";
    const fake = { call: async () => ({ emoji: { ...names, a_zz: "x", other: "x" } }) };
    const found = await createEmojiCache(fake).search(":ZZ:");
    expect(found.names).toHaveLength(20);
    expect(found.names[0]).toBe("zz_wave_00");
    expect(found.names).not.toContain("other");
    const tail = await createEmojiCache(fake).search("a_z");
    expect(tail.names).toEqual(["a_zz"]);
  });

  it("reports a missing scope and does not retry within a minute", async () => {
    slack.failNext("emoji.list", "missing_scope");
    let clock = 0;
    const cache = createEmojiCache(api(), () => clock);
    const before = slack.callsTo("emoji.list").length;
    expect(await cache.search("party")).toEqual({ names: [], error: "missing_scope" });
    clock += 30_000;
    await cache.search("party");
    expect(slack.callsTo("emoji.list").length - before).toBe(1);
  });

  it("answers without Slack access", async () => {
    expect(await createEmojiCache(undefined).search("x")).toEqual({
      names: [],
      error: "no_slack_access",
    });
  });
});

describe.skipIf(!hasDatabase)("reactToTurn", () => {
  const ledger = useLedger();
  let counter = 0;

  // A session in a thread, with the human message that started its turn.
  async function session(options: { threadRoot?: boolean; channel?: string } = {}) {
    const channel = options.channel ?? `C${++counter}REACT`;
    const root = slack.addMessage({ channel, user: "UOWNER", text: "root" });
    const sessionId = `s-react-${++counter}`;
    await recordSessionThread(ledger.sql(), {
      sessionId,
      teamId: "T1",
      channelId: channel,
      threadTs: options.threadRoot === false ? null : root.ts,
      userId: "UOWNER",
    });
    await recordTurnMessage(ledger.sql(), sessionId, root.ts);
    return { channel, root, sessionId };
  }

  // Another human message in the same thread; the next turn starts from it.
  async function nextTurn(s: Awaited<ReturnType<typeof session>>) {
    const reply = slack.addMessage({
      channel: s.channel,
      user: "UOWNER",
      text: "reply",
      thread_ts: s.root.ts,
    });
    await recordTurnMessage(ledger.sql(), s.sessionId, reply.ts);
    return reply;
  }

  const react = (sessionId: string, emoji: string, now?: Date) =>
    reactToTurn({ sql: ledger.sql(), api: api(), ...(now ? { now } : {}) }, sessionId, emoji);

  it("reacts on the message that started the turn, with colons stripped", async () => {
    const s = await session();
    expect(await react(s.sessionId, ":tada:")).toBe("Reacted with :tada:.");
    expect(slack.reactions).toContainEqual({
      channel: s.channel,
      timestamp: s.root.ts,
      name: "tada",
    });
    const reply = await nextTurn(s);
    expect(await react(s.sessionId, "🙌")).toBe("Reacted with :raised_hands:.");
    expect(slack.reactions).toContainEqual({
      channel: s.channel,
      timestamp: reply.ts,
      name: "raised_hands",
    });
  });

  it("allows one reaction per message", async () => {
    const s = await session();
    await react(s.sessionId, "tada");
    const count = slack.callsTo("reactions.add").length;
    expect(await react(s.sessionId, "fire")).toContain("already reacted");
    expect(slack.callsTo("reactions.add").length).toBe(count);
  });

  it("allows three reactions per thread per hour, then frees the window", async () => {
    const s = await session();
    for (let i = 0; i < THREAD_CAP; i++) {
      expect(await react(s.sessionId, "tada")).toContain("Reacted");
      await nextTurn(s);
    }
    const added = slack.callsTo("reactions.add").length;
    expect(await react(s.sessionId, "tada")).toContain("this thread this hour");
    expect(slack.callsTo("reactions.add").length).toBe(added);

    // Another thread has its own budget.
    const other = await session();
    expect(await react(other.sessionId, "tada")).toContain("Reacted");

    const later = new Date(Date.now() + THREAD_WINDOW_MS + 60_000);
    expect(await react(s.sessionId, "tada", later)).toContain("Reacted");
  });

  it("treats a message outside a thread as its own thread", async () => {
    const s = await session({ threadRoot: false });
    expect(await react(s.sessionId, "tada")).toContain("Reacted");
  });

  it("ignores already_reacted and keeps the claim", async () => {
    const s = await session();
    slack.reactions.push({ channel: s.channel, timestamp: s.root.ts, name: "tada" });
    expect(await react(s.sessionId, "tada")).toBe("Already reacted with :tada:.");
    expect(await react(s.sessionId, "fire")).toContain("already reacted");
  });

  it("explains an invalid name and frees the message for another try", async () => {
    const s = await session();
    slack.failNext("reactions.add", "invalid_name");
    expect(await react(s.sessionId, "not_an_emoji")).toContain("slack_emoji");
    expect(await react(s.sessionId, "tada")).toContain("Reacted");
  });

  it("returns the Slack code on another refusal and frees the message", async () => {
    const s = await session();
    slack.failNext("reactions.add", "not_reactable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await react(s.sessionId, "tada")).toContain("not_reactable");
    expect(warn).toHaveBeenCalledWith("Sym could not add a reaction: not_reactable");
    warn.mockRestore();
    expect(await react(s.sessionId, "tada")).toContain("Reacted");
  });

  it("refuses eyes and unknown unicode before touching Slack", async () => {
    const s = await session();
    const count = slack.callsTo("reactions.add").length;
    expect(await react(s.sessionId, "👀")).toContain("eyes");
    expect(await react(s.sessionId, "🦤")).toContain("name");
    expect(slack.callsTo("reactions.add").length).toBe(count);
  });

  it("refuses a session that has no Slack thread or no turn message", async () => {
    expect(await react("s-unknown", "tada")).toContain("no Slack message");
    await recordSessionThread(ledger.sql(), {
      sessionId: "s-no-message",
      teamId: null,
      channelId: "D1",
      threadTs: null,
      userId: null,
    });
    expect(await react("s-no-message", "tada")).toContain("no Slack message");
  });

  it("says so when the deployment has no Slack access", async () => {
    const s = await session();
    expect(await reactToTurn({ sql: ledger.sql(), api: undefined }, s.sessionId, "tada")).toContain(
      "no Slack access",
    );
  });

  it("is refused for a worker caller by the tool", async () => {
    const ctx = { session: { id: "s1", auth: { current: { principalId: WORKER_PRINCIPAL } } } };
    // biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
    expect(await (slackReact as any).execute({ emoji: "tada" }, ctx)).toBe(NOT_FOR_WORKERS);
    // biome-ignore lint/suspicious/noExplicitAny: same
    expect(await (slackEmoji as any).execute({ keyword: "party" }, ctx)).toBe(NOT_FOR_WORKERS);
  });
});
