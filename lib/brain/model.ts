import type { LanguageModel } from "ai";
import { anthropic } from "eve/models/anthropic";
import { openai } from "eve/models/openai";

// The model selection for the brain and its subagents. By default the model goes through the
// Vercel AI Gateway (decision 018), so any gateway model ID works, for example
// `openai/gpt-6-luna`. SYM_MODEL_PROVIDER=anthropic or openai calls that provider directly with
// its own API key, and SYM_MODEL then takes the provider's model ID (decision 080).
// `SYM_MODEL=fixture` runs the given scripted model for local end-to-end runs with no provider.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

// Eve's helpers read ANTHROPIC_API_KEY and OPENAI_API_KEY. An unset model ID uses the helper's
// default model.
const DIRECT_PROVIDERS = {
  anthropic,
  openai,
} satisfies Record<string, (model?: string) => LanguageModel>;
type DirectProvider = keyof typeof DIRECT_PROVIDERS;

function isDirectProvider(value: string): value is DirectProvider {
  return Object.hasOwn(DIRECT_PROVIDERS, value);
}

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
  const configured = env.SYM_MODEL?.trim() || undefined;
  // A live model has no gateway catalog entry, so the selection names its window.
  if (configured === "fixture") return { model: fixture(), modelContextWindowTokens: 1_000_000 };
  return { model: selectModel(configured, env), reasoning: selectReasoning(reasoning, env) };
}

function selectModel(configured: string | undefined, env: Record<string, string | undefined>) {
  const provider = env.SYM_MODEL_PROVIDER?.trim().toLowerCase() || "gateway";
  if (isDirectProvider(provider)) return DIRECT_PROVIDERS[provider](configured);
  if (provider !== "gateway")
    warnOnce(`unknown SYM_MODEL_PROVIDER "${provider}". Using "gateway".`);
  return configured ?? DEFAULT_MODEL;
}

function selectReasoning(fallback: "low" | "medium", env: Record<string, string | undefined>) {
  const override = env.SYM_REASONING?.trim().toLowerCase();
  if (!override) return fallback;
  if (isReasoning(override)) return override;
  warnOnce(`unknown SYM_REASONING "${override}". Using the default level.`);
  return fallback;
}

// Steps call stepModel often; one warning per message is enough.
const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`model: ${message}`);
}
