import type { LanguageModel } from "ai";

// The model selection for the brain and its subagents. The model goes through the Vercel AI
// Gateway (decision 018), so any gateway model ID works, for example `openai/gpt-6-luna`.
// SYM_MODEL picks it without a rebuild. `SYM_MODEL=fixture` runs the given scripted model for
// local end-to-end runs with no provider.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

// Eve's reasoning levels. Some providers reject a request that sets any level for a model
// without reasoning, so SYM_REASONING=provider-default leaves the setting out (decision 064).
const REASONING = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
type Reasoning = (typeof REASONING)[number];

function isReasoning(value: string): value is Reasoning {
  return (REASONING as readonly string[]).includes(value);
}

export function stepModel(
  fixture: () => LanguageModel,
  reasoning: "low" | "medium",
  env: Record<string, string | undefined> = process.env,
) {
  const model = env.SYM_MODEL?.trim() || DEFAULT_MODEL;
  // A live model has no gateway catalog entry, so the selection names its window.
  if (model === "fixture") return { model: fixture(), modelContextWindowTokens: 1_000_000 };
  const override = env.SYM_REASONING?.trim().toLowerCase();
  if (!override) return { model, reasoning };
  if (isReasoning(override)) return { model, reasoning: override };
  if (!warned) {
    warned = true;
    console.warn(`model: unknown SYM_REASONING "${override}". Using "${reasoning}".`);
  }
  return { model, reasoning };
}

// Steps call stepModel often; one warning is enough.
let warned = false;
