import { describe, expect, it, vi } from "vitest";
import { isReadable, keepsFacts, readabilityProblems } from "../lib/voice/readable.ts";
import { replyTightener, tightenModelId } from "../lib/voice/tighten.ts";

const WALL = `real capacity wall, not a one-time spike: checkout-api has been at maxScale (10/10 instances) for 8h+, and the platform is 429ing pushes to /webhooks/orders. this is the same issue behind the 8 p95 latency alerts since ~16:40 utc yesterday
• last hour: 199k 4xx vs 48k 2xx. 4xx per day keeps climbing: ~29k on nov 18, 262k on nov 22, 581k in the last 24h. 2xx p95 went from ~400ms to 1.3s today
• no data loss right now: the queue has 9 msgs, oldest 77s, so retries are draining it. CPU p99 ≤44%, mem ~60%, so the 40 slots (10 × concurrency 4) are waiting on I/O
next: raise maxScale 10→20 to stop the 429 churn, then find out why order handling got slower since nov 19`;

const TIGHT = `checkout-api is stuck at its 10-instance cap and returning 429s. no data loss yet.
• 429s went from 29k to 581k a day since nov 18
• CPU is under 44%, so requests wait on I/O
next: raise maxScale 10→20, then find what slowed order handling.`;

describe("readability check", () => {
  it("flags a wall of text", () => {
    expect(readabilityProblems(WALL)).toEqual([
      "2 line(s) over 160 characters",
      "3 line(s) with more than 4 numbers",
    ]);
    expect(readabilityProblems("short line.\n".repeat(80))).toEqual([
      "959 characters of prose, over 800",
    ]);
  });

  it("passes short lines with a few numbers each", () => {
    expect(isReadable(TIGHT)).toBe(true);
    expect(isReadable("yep, all green.")).toBe(true);
  });

  it("leaves code, tables, quotes, and links out of the measure", () => {
    const code = `here's the config:\n\`\`\`\n${"x = 1, 2, 3, 4, 5, 6\n".repeat(60)}\`\`\``;
    const table = `| a | b |\n|---|---|\n${"| 1 2 3 4 5 6 | 7 |\n".repeat(60)}`;
    const quote = `> ${"word ".repeat(80)}`;
    const link = `PR: https://example.com/${"a/".repeat(120)}`;
    for (const text of [code, table, quote, link]) expect(isReadable(text)).toBe(true);
  });
});

describe("fact guard", () => {
  it("lets a rewrite drop numbers but not add or change one", () => {
    expect(keepsFacts(WALL, TIGHT)).toBe(true);
    expect(keepsFacts(WALL, TIGHT.replace("581k", "600k"))).toBe(false);
  });

  it("keeps every link", () => {
    const original = "PR is up: https://example.com/pull/42. tests passed.";
    expect(keepsFacts(original, "PR https://example.com/pull/42 is up.")).toBe(true);
    expect(keepsFacts(original, "PR is up. tests passed.")).toBe(false);
  });
});

describe("rewrite model route", () => {
  it("picks a small model per provider and turns off on request or with the fixture brain", () => {
    expect(tightenModelId({})).toBe("anthropic/claude-haiku-5.5");
    expect(tightenModelId({ SYM_MODEL_PROVIDER: "anthropic" })).toBe("claude-haiku-5-5");
    expect(
      tightenModelId({ SYM_READABLE: "anthropic/claude-x", SYM_MODEL_PROVIDER: "anthropic" }),
    ).toBe("claude-x");
    expect(tightenModelId({ SYM_READABLE: "google/gemini-x" })).toBe("google/gemini-x");
    expect(tightenModelId({ SYM_MODEL_PROVIDER: "openai" })).toBeNull();
    expect(tightenModelId({ SYM_READABLE: "OFF" })).toBeNull();
    expect(tightenModelId({ SYM_MODEL: "fixture" })).toBeNull();
  });
});

describe("rewrite pass", () => {
  const tightenWith = (generate: () => Promise<string>) => {
    const tighten = replyTightener({}, generate);
    if (!tighten) throw new Error("expected a rewrite pass");
    return tighten;
  };

  it("skips the model for a readable reply", async () => {
    const generate = vi.fn(async () => "never");
    expect(await tightenWith(generate)(TIGHT)).toBe(TIGHT);
    expect(generate).not.toHaveBeenCalled();
  });

  it("posts a readable rewrite that keeps the facts", async () => {
    expect(await tightenWith(async () => `${TIGHT}\n`)(WALL)).toBe(TIGHT);
  });

  it("posts the original when the rewrite fails, invents a number, or is still a wall", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = [
      async () => {
        throw new Error("timeout");
      },
      async () => TIGHT.replace("581k", "600k"),
      async () => WALL,
      async () => "",
    ];
    for (const generate of failing) expect(await tightenWith(generate)(WALL)).toBe(WALL);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});
