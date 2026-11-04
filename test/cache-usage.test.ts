import { describe, expect, it } from "vitest";
import { cacheUsageLine } from "../lib/brain/cache-usage.ts";

const usage = {
  inputTokens: 10_000,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 1_500,
  outputTokens: 300,
};

describe("cacheUsageLine", () => {
  it("reports reads, writes, uncached input, and the hit rate of a model run", () => {
    expect(cacheUsageLine({ kind: "model", owner: { runId: "r1" }, usage })).toEqual({
      inputTokens: 10_000,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 1_500,
      uncachedTokens: 500,
      cacheHitRate: 0.8,
    });
  });

  it("skips a delegated call, which repeats its subagent's own runs", () => {
    expect(cacheUsageLine({ kind: "model", owner: { callId: "c1" }, usage })).toBeNull();
    expect(cacheUsageLine({ kind: "model", owner: { changeId: "x1" }, usage })).not.toBeNull();
  });

  it("skips a record with no input", () => {
    expect(
      cacheUsageLine({
        kind: "model",
        owner: { runId: "r1" },
        usage: { ...usage, inputTokens: 0 },
      }),
    ).toBeNull();
  });
});
