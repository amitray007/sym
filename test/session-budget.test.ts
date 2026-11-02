import { describe, expect, it } from "vitest";
import { overSessionBudget } from "../lib/brain/budget.ts";

const usage = (tokens: Partial<Record<string, number>>, costUsd?: number) => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  ...tokens,
  costUsd,
});

describe("overSessionBudget", () => {
  it("uses the gateway's reported cost", () => {
    expect(overSessionBudget(usage({ outputTokens: 10_000_000 }, 1.99))).toBe(false);
    expect(overSessionBudget(usage({}, 2))).toBe(true);
  });

  // Decision 080: direct providers report no cost; $2 is 200k output tokens at $10/M.
  it("prices a direct provider's output tokens", () => {
    expect(overSessionBudget(usage({ outputTokens: 199_000 }))).toBe(false);
    expect(overSessionBudget(usage({ outputTokens: 200_000 }))).toBe(true);
  });

  it("prices cache reads below new input", () => {
    // 900k cache reads at $0.20/M plus 100k new input at $2/M is $0.38.
    expect(overSessionBudget(usage({ inputTokens: 1_000_000, cacheReadTokens: 900_000 }))).toBe(
      false,
    );
    // 1M new input at $2/M is $2.
    expect(overSessionBudget(usage({ inputTokens: 1_000_000 }))).toBe(true);
  });
});
