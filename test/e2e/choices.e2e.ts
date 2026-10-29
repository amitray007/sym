import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, newConversation, OWNER, settle, startHarness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    database: "sym_e2e_choices",
    env: { SYM_SLACK_USERS: `${OWNER},UHELPER`, SYM_OWNER_SLACK_USER: OWNER },
  });
  await h.startEve();
});
afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

describe("offered conversation choices", () => {
  it("records a click visibly and starts one ordinary turn as the allowed clicker", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> fixture-choices");
    const offer = await c.waitForControls(/What would you like next/);
    expect(offer.controls.map((control) => control.label)).toEqual(["Show details", "Leave it"]);
    await c.click(offer, "Show details", "UOUTSIDER");
    await settle(h);
    expect(
      c
        .botMessages()
        .some((m) =>
          (m.text ?? m.markdown_text ?? "").includes("Fixture brain heard: Show details"),
        ),
    ).toBe(false);
    await c.click(offer, "Show details", "UHELPER");
    await c.waitForPrompt(/Fixture brain heard: Show details/);
    await settle(h);
    expect(offer.message.text).toContain("<@UHELPER> chose: Show details");
    expect(JSON.stringify(offer.message.blocks)).not.toContain("sym_choice_");
    const [row] = await h.sql<
      { userId: string }[]
    >`select user_id from session_threads where channel_id = ${c.channel} order by updated_at desc limit 1`;
    expect(row?.userId).toBe("UHELPER");
    await c.click(offer, "Show details", "UHELPER");
    await settle(h);
    expect(
      c
        .botMessages()
        .filter((m) =>
          (m.text ?? m.markdown_text ?? "").includes("Fixture brain heard: Show details"),
        ),
    ).toHaveLength(1);
    expect(await h.sql`select id from jobs`).toHaveLength(0);
  });

  it("accepts a typed reply while the options remain open", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> fixture-choices");
    await c.waitForControls(/What would you like next/);
    await c.say("I'd like something else");
    await c.waitForPrompt(/something else/, 15000).catch((error) => {
      console.error(
        c.botMessages().map((m) => m.text ?? m.markdown_text ?? JSON.stringify(m.blocks)),
      );
      throw error;
    });
    const pending =
      await h.sql`select id from conversation_choices where channel = ${c.channel} and chosen_by is null`;
    expect(pending).toHaveLength(1);
  });
});
