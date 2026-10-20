import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getListenMode, setListenMode } from "../../lib/ledger/listen.ts";
import { lastTurnUser } from "../../lib/ledger/threads.ts";
import {
  type Conversation,
  type Harness,
  newConversation,
  OWNER,
  settle,
  startHarness,
  until,
} from "./harness.ts";

// Shared threads end to end (docs/slack.md, decision 050): Sym answers a message in a thread
// with a session only when the message is meant for it. The fixture brain echoes a message and
// calls no_reply when the message says "thinking out loud".

const ALLOWED = "UALLOWED";
const OTHER = "UOTHERPERSON";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    database: "sym_e2e_threads",
    env: { SYM_SLACK_USERS: `${OWNER},${ALLOWED}`, SYM_OWNER_SLACK_USER: OWNER },
  });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

const statusesOf = (c: Conversation) =>
  h.slack.statuses.filter((s) => s.thread_ts === c.rootTs && s.status !== "").length;

// A thread whose first turn Sym answered.
async function startedThread(): Promise<Conversation> {
  const c = newConversation(h);
  await c.mention(`<@UBOT> hello there`);
  await until(() => (c.botMessages().length >= 1 ? true : undefined), { label: "the first reply" });
  // The first turn may still post after its reply. Each test counts from a quiet thread.
  await settle(h);
  return c;
}

describe("shared threads", () => {
  it("answers a follow-up in a thread with one person", async () => {
    const c = await startedThread();
    await c.say("and one more thing");
    await until(() => (c.botMessages().length >= 2 ? true : undefined), {
      label: "the follow-up reply",
    });
  });

  it("stays out of talk between people and shows no status for a quiet turn", async () => {
    const c = await startedThread();
    await c.say("looks right to me", ALLOWED);
    await settle(h);
    const messagesBefore = c.botMessages().length;
    const statusesBefore = statusesOf(c);

    // Tags another person: for them, not for Sym.
    await c.say(`<@${OTHER}> can you check the deploy?`, ALLOWED);
    // No tag, no name, and not the person Sym serves.
    await c.say("does anyone know when it ships?", ALLOWED);
    await settle(h);
    expect(c.botMessages()).toHaveLength(messagesBefore);
    expect(statusesOf(c)).toBe(statusesBefore);

    // The person Sym serves, untagged and not asking: a quiet turn that ends in silence.
    await c.say("hm, thinking out loud here");
    await settle(h);
    expect(c.botMessages()).toHaveLength(messagesBefore);
    expect(statusesOf(c)).toBe(statusesBefore);

    // The same person, now asking Sym by name for work that needs a tool: the turn becomes real,
    // so it shows a status and replies.
    await c.say("sym, what is the status?");
    await until(() => (c.botMessages().length > messagesBefore ? true : undefined), {
      label: "the reply to a message that names Sym",
    });
    expect(statusesOf(c)).toBeGreaterThan(statusesBefore);
  });

  it("lets someone else start a turn by name, and keeps who Sym serves", async () => {
    const c = await startedThread();
    await c.say("hi all", ALLOWED);
    const before = c.botMessages().length;
    await c.say("sym, are you around?", ALLOWED);
    await until(() => (c.botMessages().length > before ? true : undefined), {
      label: "the reply to a named message",
    });
    expect(await lastTurnUser(h.sql, c.channel, c.rootTs)).toBe(OWNER);
  });

  it("answers only a tag when the thread is mention-only", async () => {
    const c = await startedThread();
    await setListenMode(h.sql, {
      channelId: c.channel,
      threadTs: c.rootTs,
      mode: "mention-only",
      updatedBy: OWNER,
    });
    expect(await getListenMode(h.sql, c.channel, c.rootTs)).toBe("mention-only");
    const before = c.botMessages().length;
    await c.say("sym, are you there?");
    await settle(h);
    expect(c.botMessages()).toHaveLength(before);

    await c.reply(`<@UBOT> now you`);
    await until(() => (c.botMessages().length > before ? true : undefined), {
      label: "the reply to a tag",
    });
  });

  it("skips a follow-up when the listen mode cannot be read", async () => {
    const c = await startedThread();
    const before = c.botMessages().length;
    await h.sql`alter table thread_listen rename to thread_listen_off`;
    try {
      await c.say("and one more thing");
      await settle(h);
      expect(c.botMessages()).toHaveLength(before);
    } finally {
      await h.sql`alter table thread_listen_off rename to thread_listen`;
    }
    await c.say("and one more thing");
    await until(() => (c.botMessages().length > before ? true : undefined), {
      label: "the reply once the mode is readable",
    });
  });

  it("keeps one person's quiet mark apart from another person's tagged turn", async () => {
    const c = await startedThread();
    const before = c.botMessages().length;
    // Two people at once: the owner tags Sym, and another person names Sym.
    await Promise.all([c.reply("<@UBOT> hello again"), c.say("sym, are you there?", ALLOWED)]);
    await until(() => (c.botMessages().length >= before + 2 ? true : undefined), {
      label: "both replies",
    });
    expect(await lastTurnUser(h.sql, c.channel, c.rootTs)).toBe(OWNER);
  });
});
