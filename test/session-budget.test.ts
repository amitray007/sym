import { afterEach, describe, expect, it, vi } from "vitest";
import researcher from "../agent/subagents/researcher/agent.ts";
import { overSessionBudget, researchBudgetUsd } from "../lib/brain/budget.ts";

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

  // Decision 094: input includes cache writes, priced above new input.
  it("prices cache writes by the cache lifetime", () => {
    const writes = usage({ inputTokens: 750_000, cacheWriteTokens: 750_000 });
    // 750k writes at $2.50/M (1.25x) is $1.875.
    expect(overSessionBudget(writes, 2, {})).toBe(false);
    // 750k writes at $4/M (2x) is $3.
    expect(
      overSessionBudget(writes, 2, { SYM_MODEL_PROVIDER: "anthropic", SYM_PROMPT_CACHE_TTL: "1h" }),
    ).toBe(true);
  });
});

afterEach(() => vi.unstubAllEnvs());

it("gives research its own smaller window for reported cost and direct-provider tokens", () => {
  const limit = researcher.limits.sessionUsage;
  vi.stubEnv("SYM_RESEARCH_BUDGET_USD", "0.5");
  const below = usage({}, 0.49);
  const at = usage({}, 0.5);
  const check = (window: typeof at) => limit({ window, total: window });
  expect(check(below)).toBe(false);
  expect(check(at)).toBe(true);
  expect(check(usage({ outputTokens: 49_000 }))).toBe(false);
  expect(check(usage({ outputTokens: 50_000 }))).toBe(true);
  expect(overSessionBudget(at)).toBe(false);
  vi.stubEnv("SYM_RESEARCH_BUDGET_USD", "0.25");
  expect(check(usage({}, 0.25))).toBe(true);
});

it.each([undefined, "", "0", "-1", "not-a-number", "Infinity"])(
  "defaults an invalid research budget (%s) to $0.50",
  (value) => {
    expect(researchBudgetUsd({ SYM_RESEARCH_BUDGET_USD: value })).toBe(0.5);
  },
);
