/**
 * Shared Fireworks model builder for Pi.
 *
 * Single source of truth for the Model<'openai-completions'> config used by
 * both the Pi turn loop and the spike. Callers supply the Fireworks baseUrl +
 * model id; the rest is fixed Fireworks compat metadata.
 */

import type { Model } from '@earendil-works/pi-ai';

export interface FireworksModelCfg {
  /** Fireworks base URL, e.g. `https://api.fireworks.ai/inference/v1`. */
  baseUrl: string;
  /** Fireworks model id, e.g. `accounts/fireworks/models/llama-v3p1-70b-instruct`. */
  modelId: string;
}

/**
 * Build a `Model<'openai-completions'>` for the Fireworks endpoint.
 *
 * - `compat.supportsStore: false` — Fireworks rejects the OpenAI `store` field.
 * - `compat.supportsUsageInStreaming: false` — Fireworks does not send usage in
 *   streaming chunks; Pi will read it from the final non-streaming response body
 *   if available, or skip it.
 */
export function buildFireworksModel(cfg: FireworksModelCfg): Model<'openai-completions'> {
  return {
    id: cfg.modelId,
    name: 'Fireworks (Sym)',
    api: 'openai-completions',
    provider: 'fireworks',
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 4_096,
    compat: {
      supportsStore: false,
    },
  };
}
