import type { TokenUsage } from "eve";

const SESSION_BUDGET_USD = 2;

// Only AI Gateway reports costUsd, so a direct provider (decision 080) is priced from its tokens.
// Reference rates in USD per million tokens: Sonnet-class list prices.
const REFERENCE_RATES = { input: 2, cacheRead: 0.2, output: 10 };

export function overSessionBudget(window: TokenUsage): boolean {
  return (window.costUsd ?? estimatedCostUsd(window)) >= SESSION_BUDGET_USD;
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
