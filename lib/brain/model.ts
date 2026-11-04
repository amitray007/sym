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
  const model = selectModel(configured, env);
  const level = selectReasoning(reasoning, env);
  // Eve caches Anthropic prompts for 5 minutes by default and rejects promptCache on the gateway.
  if (promptCacheTtl(env) === "1h" && selectedProvider(env) === "anthropic") {
    const promptCache = { anthropic: { ttl: "1h" as const } };
    return { model, reasoning: level, modelOptions: { promptCache } };
  }
  return { model, reasoning: level };
}

// SYM_PROMPT_CACHE_TTL=1h keeps the brain's cached prompt for an hour on the direct Anthropic
// route (decision 094). Slack replies often come more than 5 minutes apart. A 1-hour cache write
// costs 2x input instead of 1.25x; a read costs the same.
export function promptCacheTtl(env: Record<string, string | undefined> = process.env): "5m" | "1h" {
  const value = env.SYM_PROMPT_CACHE_TTL?.trim().toLowerCase();
  if (!value || value === "5m") return "5m";
  if (value === "1h") {
    if (selectedProvider(env) !== "anthropic")
      warnOnce("SYM_PROMPT_CACHE_TTL=1h applies only to SYM_MODEL_PROVIDER=anthropic.");
    return "1h";
  }
  warnOnce(`unknown SYM_PROMPT_CACHE_TTL "${value}". Using "5m".`);
  return "5m";
}

function selectedProvider(env: Record<string, string | undefined>) {
  return env.SYM_MODEL_PROVIDER?.trim().toLowerCase() || "gateway";
}

function selectModel(configured: string | undefined, env: Record<string, string | undefined>) {
  const provider = selectedProvider(env);
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
