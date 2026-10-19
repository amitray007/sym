import { describe, expect, it } from "vitest";
import { chooseDisplay, type DisplayInput } from "../lib/display.ts";

const base: DisplayInput = {
  kind: "question",
  needsAction: false,
  isNew: true,
  estMinutes: 0.5,
  steps: 1,
  lines: 5,
  surface: "channel",
  quiet: false,
};

describe("chooseDisplay", () => {
  it("posts buttons when someone must act, even in quiet mode", () => {
    expect(chooseDisplay({ ...base, needsAction: true, quiet: true }).level).toBe(2);
  });

  it("stays silent when nothing is new", () => {
    expect(chooseDisplay({ ...base, kind: "on-call-check", isNew: false }).level).toBe(0);
  });

  it("holds normal posts for the digest in quiet mode", () => {
    expect(chooseDisplay({ ...base, quiet: true }).level).toBe(0);
  });

  it("posts failures in quiet mode", () => {
    expect(chooseDisplay({ ...base, quiet: true, failed: true }).level).toBe(1);
  });

  it("answers a short question with text", () => {
    expect(chooseDisplay(base)).toMatchObject({ level: 1, target: "thread" });
  });

  it("gives a long code job a live card", () => {
    const choice = chooseDisplay({ ...base, kind: "code-change", estMinutes: 15, steps: 6 });
    expect(choice.level).toBe(3);
  });

  it("keeps short work with many steps as text", () => {
    expect(chooseDisplay({ ...base, estMinutes: 1, steps: 6 }).level).toBe(1);
  });

  it("lets the requester force text", () => {
    const choice = chooseDisplay({ ...base, estMinutes: 15, steps: 6, hint: "text" });
    expect(choice).toMatchObject({ level: 1, reason: "requester asked for text" });
  });

  it("lets the requester force a card", () => {
    expect(chooseDisplay({ ...base, hint: "card" }).level).toBe(3);
  });

  it("applies a learned text-only preference", () => {
    const choice = chooseDisplay({ ...base, estMinutes: 15, steps: 6, prefs: { textOnly: true } });
    expect(choice.level).toBe(1);
  });

  it("turns a long answer into a summary and a file", () => {
    expect(chooseDisplay({ ...base, lines: 120 }).level).toBe(4);
    expect(chooseDisplay({ ...base, tableRows: 25 }).level).toBe(4);
  });

  it("sends updates for jobs not asked in a shared channel to the DM", () => {
    expect(chooseDisplay({ ...base, surface: "shared-channel" }).target).toBe("dm");
    expect(chooseDisplay({ ...base, surface: "shared-channel", askedHere: true }).target).toBe(
      "thread",
    );
  });
});
