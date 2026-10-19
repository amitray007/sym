import { describe, expect, it } from "vitest";
import { canSkipStart } from "../lib/schedules/approval.ts";
import { runOutcome } from "../lib/schedules/outcome.ts";

const brief = { project: "p", title: "On-call check", goal: "g", doneWhen: ["d"] };
const active = { status: "active" as const, brief };

describe("canSkipStart", () => {
  const ok = { isSchedulePrincipal: true, schedule: active, brief };

  it("skips the click for the schedule principal, an active row, and the same brief", () => {
    expect(canSkipStart(ok)).toBe(true);
    // Key order and explicit defaults do not matter.
    expect(
      canSkipStart({
        ...ok,
        brief: {
          doneWhen: ["d"],
          goal: "g",
          title: "On-call check",
          project: "p",
          constraints: [],
        },
      }),
    ).toBe(true);
  });

  it("asks when someone else started the session", () => {
    expect(canSkipStart({ ...ok, isSchedulePrincipal: false })).toBe(false);
  });

  it.each(["pending_approval", "paused", "deleted"] as const)("asks for a %s row", (status) => {
    expect(canSkipStart({ ...ok, schedule: { ...active, status } })).toBe(false);
  });

  it("asks without a row, or when the brief differs", () => {
    expect(canSkipStart({ ...ok, schedule: undefined })).toBe(false);
    expect(canSkipStart({ ...ok, brief: { ...brief, goal: "something wider" } })).toBe(false);
    expect(canSkipStart({ ...ok, brief: { ...brief, constraints: ["x"] } })).toBe(false);
    expect(canSkipStart({ ...ok, brief: "nonsense" })).toBe(false);
  });
});

describe("runOutcome", () => {
  it("is all clear for a done job with no open questions", () => {
    expect(runOutcome("done", { openQuestions: [] })).toBe("all_clear");
  });

  it("needs attention when the result breaks a rule, even with no open questions", () => {
    expect(runOutcome("done", { openQuestions: [] }, ["A PR the job did not allow."])).toBe(
      "needs_attention",
    );
  });
  it("needs attention for open questions, a missing contract, or a stop", () => {
    expect(runOutcome("done", { openQuestions: ["q"] })).toBe("needs_attention");
    expect(runOutcome("done", null)).toBe("needs_attention");
    expect(runOutcome("cancelled", null)).toBe("needs_attention");
  });
  it("is failed for a failed job", () => {
    expect(runOutcome("failed", { openQuestions: [] })).toBe("failed");
  });
});
