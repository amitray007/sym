import type { TokenUsage } from "eve";
import { promptCacheTtl } from "./model.ts";

const SESSION_BUDGET_USD = 2;

// Only AI Gateway reports costUsd, so a direct provider (decision 080) is priced from its tokens.
// Reference rates in USD per million tokens: Sonnet-class list prices. A cache write costs 1.25x
// input for the 5-minute cache and 2x for the 1-hour cache.
const REFERENCE_RATES = { input: 2, cacheRead: 0.2, output: 10 };
const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 };

export function overSessionBudget(
  window: TokenUsage,
  usd = SESSION_BUDGET_USD,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (window.costUsd ?? estimatedCostUsd(window, promptCacheTtl(env))) >= usd;
}

// Eve's inputTokens includes cache reads and writes.
function estimatedCostUsd(usage: TokenUsage, ttl: "5m" | "1h"): number {
  const newInput = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const cacheWriteRate = REFERENCE_RATES.input * CACHE_WRITE_MULTIPLIER[ttl];
  return (
    (newInput * REFERENCE_RATES.input +
      usage.cacheReadTokens * REFERENCE_RATES.cacheRead +
      usage.cacheWriteTokens * cacheWriteRate +
      usage.outputTokens * REFERENCE_RATES.output) /
    1_000_000
  );
}

export function researchBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.SYM_RESEARCH_BUDGET_USD);
  return Number.isFinite(value) && value > 0 ? value : 0.5;
}
