import { describe, expect, it } from "vitest";
import {
  mentionedUserIds,
  namesBot,
  THREAD_FETCH_LIMIT,
  type TriageInput,
  threadPeople,
  triageThreadMessage,
} from "../lib/slack/addressing.ts";

const shared = { ids: ["UANN", "UBOB"], complete: true };

function triage(overrides: Partial<TriageInput> = {}) {
  return triageThreadMessage({
    senderId: "UANN",
    text: "looks good",
    mentionsBot: false,
    botName: "sym",
    listenMode: "all",
    people: shared,
    partnerId: undefined,
    ...overrides,
  });
}

describe("triageThreadMessage", () => {
  it("replies to a message that tags Sym, even in mention-only mode", () => {
    expect(triage({ mentionsBot: true })).toBe("reply");
    expect(triage({ mentionsBot: true, listenMode: "mention-only" })).toBe("reply");
    expect(triage({ mentionsBot: true, text: "<@UBOB> and <@UBOT>" })).toBe("reply");
  });

  it("skips every untagged message in mention-only mode", () => {
    const solo = { ids: ["UANN"], complete: true };
    expect(triage({ listenMode: "mention-only", people: solo })).toBe("skip");
    expect(triage({ listenMode: "mention-only", partnerId: "UANN" })).toBe("skip");
    expect(triage({ listenMode: "mention-only", text: "sym, status?" })).toBe("skip");
  });

  it("skips a message that tags another person", () => {
    const solo = { ids: ["UANN"], complete: true };
    expect(triage({ text: "<@UBOB> can you check?", people: solo })).toBe("skip");
    expect(triage({ text: "<@UBOB|bob> sym, look", partnerId: "UANN" })).toBe("skip");
  });

  it("ignores a tag of the sender", () => {
    const solo = { ids: ["UANN"], complete: true };
    expect(triage({ text: "note to <@UANN>: retry", people: solo })).toBe("reply");
  });

  it("replies in a solo thread", () => {
    expect(triage({ people: { ids: ["UANN"], complete: true } })).toBe("reply");
  });

  it("counts the sender even when the fetch missed them", () => {
    expect(triage({ people: { ids: ["UBOB"], complete: true } })).toBe("skip");
  });

  it.each([
    ["empty", { ids: [], complete: false }],
    ["failed or truncated", { ids: ["UANN"], complete: false }],
  ])("treats %s evidence as a shared thread", (_name, people) => {
    expect(triage({ people })).toBe("skip");
    expect(triage({ people, partnerId: "UANN" })).toBe("maybe");
  });

  it("lets the partner start a quiet turn in a shared thread", () => {
    expect(triage({ partnerId: "UANN" })).toBe("maybe");
  });

  it("does not give a quiet turn to someone who is not the partner", () => {
    expect(triage({ partnerId: "UBOB" })).toBe("skip");
  });

  it("lets a message that says Sym's name start a quiet turn", () => {
    expect(triage({ text: "Sym, what is the status?", partnerId: "UBOB" })).toBe("maybe");
    expect(triage({ text: "ask SYM", botName: "Sym" })).toBe("maybe");
    expect(triage({ text: "hey atlas", botName: "Atlas" })).toBe("maybe");
  });

  it("skips a message that only has the name inside another word, code, or a quote", () => {
    expect(triage({ text: "the symbols are wrong" })).toBe("skip");
    expect(triage({ text: "run `sym status` first" })).toBe("skip");
    expect(triage({ text: "> sym said no\nagreed" })).toBe("skip");
  });
});

describe("namesBot", () => {
  it("matches the name as a word in any case", () => {
    expect(namesBot("sym?", "sym")).toBe(true);
    expect(namesBot("thanks, Sym.", "sym")).toBe(true);
    expect(namesBot("Sym's job", "sym")).toBe(true);
    expect(namesBot("symmetric", "sym")).toBe(false);
    expect(namesBot("my-sym", "sym")).toBe(true);
  });

  it("ignores a tag and an empty name", () => {
    expect(namesBot("<@USYM|sym> hi", "sym")).toBe(false);
    expect(namesBot("sym", " ")).toBe(false);
  });

  it("escapes a name with pattern characters", () => {
    expect(namesBot("hi s.m", "s.m")).toBe(true);
    expect(namesBot("hi sxm", "s.m")).toBe(false);
  });
});

describe("mentionedUserIds", () => {
  it("reads plain and labeled tags only", () => {
    expect(mentionedUserIds("<@U1> <@W2|bob> <!here> <#C1>")).toEqual(["U1", "W2"]);
  });
});

describe("threadPeople", () => {
  it("is complete when the fetch found people and stayed under the limit", () => {
    expect(threadPeople(3, ["U1"])).toEqual({ ids: ["U1"], complete: true });
  });

  it("is incomplete when nothing came back or the fetch reached the limit", () => {
    expect(threadPeople(0, [])).toEqual({ ids: [], complete: false });
    expect(threadPeople(THREAD_FETCH_LIMIT, ["U1"]).complete).toBe(false);
    expect(threadPeople(THREAD_FETCH_LIMIT - 1, ["U1"]).complete).toBe(true);
  });
});
