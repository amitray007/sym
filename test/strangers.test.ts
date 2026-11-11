import { describe, expect, it } from "vitest";
import {
  CASUAL_LINES,
  createStrangerCooldown,
  NO_OWNER_LINE,
  PLAIN_LINE,
  SPICY_LINES,
  strangerKey,
  strangerLine,
  strangerRepliesOn,
} from "../lib/slack/strangers.ts";

const OWNER_ID = "UOWNER";
const TAG = "<@UOWNER>";

const sourcesOf = (stored?: "plain" | "casual" | "spicy") => ({ stored });

describe("strangerLine", () => {
  it("gives the spicy persona the spicy lines and the casual persona the casual lines", () => {
    const spicy = strangerLine({ sources: sourcesOf("spicy"), ownerId: OWNER_ID, random: () => 0 });
    expect(spicy).toBe(
      "I'm a bouncer with a very short list, and you're not on it. <@UOWNER> owns the club.",
    );
    const casual = strangerLine({
      sources: sourcesOf("casual"),
      ownerId: OWNER_ID,
      random: () => 0,
    });
    expect(casual).toBe("I'm not set up to help you yet. Ask <@UOWNER> for access.");
  });

  it("picks a uniform line, including the last one, and tags the owner in every one", () => {
    expect(SPICY_LINES).toHaveLength(15);
    expect(CASUAL_LINES).toHaveLength(2);
    for (const [persona, list] of [
      ["spicy", SPICY_LINES],
      ["casual", CASUAL_LINES],
    ] as const) {
      for (const [index, template] of list.entries()) {
        expect(template).toContain("{owner}");
        const line = strangerLine({
          sources: sourcesOf(persona),
          ownerId: OWNER_ID,
          random: () => (index + 0.5) / list.length,
        });
        expect(line).toBe(template.replace("{owner}", TAG));
        expect(line).not.toContain("{");
      }
      const last = strangerLine({
        sources: sourcesOf(persona),
        ownerId: OWNER_ID,
        random: () => 0.999999,
      });
      expect(last).toBe(list.at(-1)?.replace("{owner}", TAG));
    }
  });

  it("gives the straight line to the plain persona and to a pack persona", () => {
    const plain = strangerLine({ sources: sourcesOf("plain"), ownerId: OWNER_ID });
    expect(plain).toBe(PLAIN_LINE.replace("{owner}", TAG));
    const pack = { persona: { content: "Talk like a pirate." } } as never;
    expect(strangerLine({ sources: { stored: "spicy", pack }, ownerId: OWNER_ID })).toBe(plain);
  });

  it("reads SYM_PERSONA and defaults to casual", () => {
    const random = () => 0;
    expect(strangerLine({ sources: { env: "plain" }, ownerId: OWNER_ID, random })).toBe(
      PLAIN_LINE.replace("{owner}", TAG),
    );
    expect(strangerLine({ sources: { env: "spicy" }, ownerId: OWNER_ID, random })).toBe(
      SPICY_LINES[0]?.replace("{owner}", TAG),
    );
    expect(strangerLine({ sources: {}, ownerId: OWNER_ID, random })).toBe(
      CASUAL_LINES[0]?.replace("{owner}", TAG),
    );
  });

  it("names nobody without an owner, for every persona", () => {
    for (const stored of ["plain", "casual", "spicy"] as const) {
      expect(strangerLine({ sources: sourcesOf(stored), ownerId: undefined })).toBe(NO_OWNER_LINE);
    }
  });
});

describe("strangerRepliesOn", () => {
  it("is on unless set to an off value", () => {
    expect(strangerRepliesOn(undefined)).toBe(true);
    expect(strangerRepliesOn("")).toBe(true);
    expect(strangerRepliesOn("on")).toBe(true);
    expect(strangerRepliesOn(" OFF ")).toBe(false);
    expect(strangerRepliesOn("no")).toBe(false);
  });
});

describe("stranger cooldown", () => {
  it("releases a failed delivery for retry", () => {
    const cooldown = createStrangerCooldown();
    expect(cooldown.claim("U:C", 1)).toBe(true);
    cooldown.release("U:C");
    expect(cooldown.claim("U:C", 2)).toBe(true);
  });
  const HOUR = 60 * 60 * 1000;

  it("allows one line per user and channel each hour", () => {
    const cooldown = createStrangerCooldown();
    const key = strangerKey("U1", "C1");
    expect(cooldown.claim(key, 0)).toBe(true);
    expect(cooldown.claim(key, HOUR - 1)).toBe(false);
    expect(cooldown.claim(key, HOUR)).toBe(true);
  });

  it("keeps users and channels apart", () => {
    const cooldown = createStrangerCooldown();
    expect(cooldown.claim(strangerKey("U1", "C1"), 0)).toBe(true);
    expect(cooldown.claim(strangerKey("U2", "C1"), 0)).toBe(true);
    expect(cooldown.claim(strangerKey("U1", "C2"), 0)).toBe(true);
    expect(cooldown.claim(strangerKey("U1", "C1"), 1)).toBe(false);
  });

  it("forgets the oldest key past its size cap", () => {
    const cooldown = createStrangerCooldown(HOUR, 2);
    cooldown.claim("a", 0);
    cooldown.claim("b", 0);
    cooldown.claim("c", 0);
    expect(cooldown.claim("a", 1)).toBe(true);
    expect(cooldown.claim("c", 1)).toBe(false);
  });
});
