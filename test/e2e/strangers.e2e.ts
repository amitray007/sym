import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, newConversation, OWNER, settle, startHarness, until } from "./harness.ts";

// Stranger replies end to end (docs/slack.md, decision 053): a person off the allow-list who
// tags Sym or names it in a thread gets one private line per hour and starts no turn.

const STRANGER = "USTRANGER";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    database: "sym_e2e_strangers",
    env: { SYM_SLACK_USERS: OWNER, SYM_OWNER_SLACK_USER: OWNER },
  });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

const toStranger = () => h.slack.ephemerals.filter((m) => m.target_user === STRANGER);

describe("stranger replies", () => {
  it("answers a tag once, privately, with no turn, and not again within the hour", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> hello there", STRANGER);
    const line = await until(() => toStranger().find((m) => m.channel === c.channel), {
      label: "the stranger line",
    });
    expect(line.text).toContain(`<@${OWNER}>`);
    // A top-level tag gets its line in the channel.
    expect(line.thread_ts).toBeUndefined();

    await c.reply("<@UBOT> please?", STRANGER);
    await settle(h);
    expect(toStranger().filter((m) => m.channel === c.channel)).toHaveLength(1);
    expect(c.botMessages()).toHaveLength(0);
    expect(await h.sql`select * from session_threads`).toHaveLength(0);
  });

  it("gives nothing for untagged side talk in a thread with a session", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> hello there");
    await until(() => (c.botMessages().length >= 1 ? true : undefined), { label: "first reply" });
    await settle(h);
    const before = h.slack.ephemerals.length;
    const messages = c.botMessages().length;

    await c.say("does anyone know when it ships?", STRANGER);
    await settle(h);
    expect(h.slack.ephemerals).toHaveLength(before);

    // Naming Sym in that thread does earn a line, and still no turn.
    await c.say("sym, are you around?", STRANGER);
    await until(() => (h.slack.ephemerals.length > before ? true : undefined), {
      label: "the line for a stranger who names Sym",
    });
    await settle(h);
    expect(c.botMessages()).toHaveLength(messages);
  });
});
