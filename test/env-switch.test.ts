import { describe, expect, it } from "vitest";
import { envSwitch } from "../lib/env-switch.ts";
import { prFollowEnabled } from "../lib/jobs/pr-wakes.ts";
import { verifierEnabled } from "../lib/jobs/verify.ts";

describe("envSwitch", () => {
  it("reads on and off words in any case, and falls back otherwise", () => {
    for (const value of ["on", "ON", "true", "1", "yes", " Yes "]) {
      expect(envSwitch(value, false)).toBe(true);
    }
    for (const value of ["off", "OFF", "false", "0", "no", " No "]) {
      expect(envSwitch(value, true)).toBe(false);
    }
    for (const value of [undefined, "", "  ", "maybe"]) {
      expect(envSwitch(value, true)).toBe(true);
      expect(envSwitch(value, false)).toBe(false);
    }
  });
});

describe("opt-in switches (decision 054)", () => {
  it("keeps the verifier and PR follow off unless set on", () => {
    expect(verifierEnabled({})).toBe(false);
    expect(verifierEnabled({ SYM_VERIFIER: "on" })).toBe(true);
    expect(prFollowEnabled({})).toBe(false);
    expect(prFollowEnabled({ SYM_PR_FOLLOW: "on" })).toBe(true);
  });
});
