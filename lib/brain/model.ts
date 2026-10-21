import type { LanguageModel } from "ai";

// The model selection for the brain and its subagents. The model goes through the Vercel AI
// Gateway (decision 018), so any gateway model ID works, for example `openai/gpt-6-luna`.
// SYM_MODEL picks it without a rebuild. `SYM_MODEL=fixture` runs the given scripted model for
// local end-to-end runs with no provider.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

export function stepModel(fixture: () => LanguageModel, reasoning: "low" | "medium") {
  const model = process.env.SYM_MODEL?.trim() || DEFAULT_MODEL;
  // A live model has no gateway catalog entry, so the selection names its window.
  if (model === "fixture") return { model: fixture(), modelContextWindowTokens: 1_000_000 };
  return { model, reasoning };
}
