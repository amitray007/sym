import { describe, expect, it } from "vitest";
import { canSkipStart } from "../lib/schedules/approval.ts";
import { runOutcome } from "../lib/schedules/outcome.ts";

const auto = { status: "active" as const, builder: "auto" as const };

describe("canSkipStart", () => {
  const ok = { isSchedulePrincipal: true, schedule: auto };

  it("skips the click for the schedule principal and an active auto-start row", () => {
    expect(canSkipStart(ok)).toBe(true);
  });

  it("skips it for a one-time row that is done because this run fired it", () => {
    expect(canSkipStart({ ...ok, schedule: { ...auto, status: "done" } })).toBe(true);
  });

  it("asks when the schedule asks for Start", () => {
    expect(canSkipStart({ ...ok, schedule: { ...auto, builder: "ask" } })).toBe(false);
  });

  it("asks when someone else started the session", () => {
    expect(canSkipStart({ ...ok, isSchedulePrincipal: false })).toBe(false);
  });

  it.each(["paused", "deleted"] as const)("asks for a %s row", (status) => {
    expect(canSkipStart({ ...ok, schedule: { ...auto, status } })).toBe(false);
  });

  it("asks without a row", () => {
    expect(canSkipStart({ ...ok, schedule: undefined })).toBe(false);
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
