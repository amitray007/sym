/**
 * Shared Fireworks model builder for Pi.
 *
 * Returns the pi-ai registry entry for the requested Fireworks model, with the
 * caller-supplied baseUrl overridden on top. We MUST use the registry entry
 * (not a hand-rolled config) so the correct Harmony-aware api surface is
 * selected — e.g. Fireworks's gpt-oss-120b is `anthropic-messages`, which
 * demuxes Harmony channels (analysis/commentary/final) into proper text vs
 * thinking content. Calling it via `openai-completions` leaks reasoning text
 * and phantom tool-call frames into `delta.content`.
 */

import { getModel, type Model } from '@earendil-works/pi-ai';

export interface FireworksModelCfg {
  /** Fireworks base URL, e.g. `https://api.fireworks.ai/inference/v1`. */
  baseUrl: string;
  /** Fireworks model id, e.g. `accounts/fireworks/models/gpt-oss-120b`. */
  modelId: string;
}

/**
 * Build a `Model<'anthropic-messages'>` for the Fireworks endpoint by looking
 * up the registry entry and overriding `baseUrl` with the env-supplied value.
 *
 * Throws if the modelId is unknown or its api surface is not anthropic-messages
 * — the demux behaviour is load-bearing for clean streaming.
 */
export function buildFireworksModel(cfg: FireworksModelCfg): Model<'anthropic-messages'> {
  // getModel is strictly typed on TModelId — runtime lookup is what matters here,
  // so we cast through unknown to accept the user's env-supplied modelId string.
  const known = getModel(
    'fireworks',
    cfg.modelId as unknown as 'accounts/fireworks/models/gpt-oss-120b',
  );
  if (!known) throw new Error(`unknown Fireworks model: ${cfg.modelId}`);
  if (known.api !== 'anthropic-messages') {
    throw new Error(
      `expected anthropic-messages model for Harmony demux, got ${known.api} for ${cfg.modelId}`,
    );
  }
  return { ...known, baseUrl: cfg.baseUrl };
}
