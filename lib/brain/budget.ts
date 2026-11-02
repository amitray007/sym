import type { TokenUsage } from "eve";

const SESSION_BUDGET_USD = 2;

// Only AI Gateway reports costUsd, so a direct provider (decision 080) is priced from its tokens.
// Reference rates in USD per million tokens: Sonnet-class list prices.
const REFERENCE_RATES = { input: 2, cacheRead: 0.2, output: 10 };

export function overSessionBudget(window: TokenUsage, usd = SESSION_BUDGET_USD): boolean {
  return (window.costUsd ?? estimatedCostUsd(window)) >= usd;
}

function estimatedCostUsd(usage: TokenUsage): number {
  const newInput = usage.inputTokens - usage.cacheReadTokens;
  return (
    (newInput * REFERENCE_RATES.input +
      usage.cacheReadTokens * REFERENCE_RATES.cacheRead +
      usage.outputTokens * REFERENCE_RATES.output) /
    1_000_000
  );
}

export function researchBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.SYM_RESEARCH_BUDGET_USD);
  return Number.isFinite(value) && value > 0 ? value : 0.5;
}
