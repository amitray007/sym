/**
 * Tone-rewrite stage.
 *
 * Takes a draft Markdown reply and the resolved soul cascade, rewrites the
 * reply through the cascade's voice, then runs the substance-diff guard.
 *
 * If the guard detects a factual change in the rewrite, `accepted` is set to
 * `false` and the caller MUST deliver the original `draftMarkdown` instead.
 *
 * Design constraints:
 *   - NEVER reads env or makes live network calls.  The provider is INJECTED
 *     by the caller (typically the kernel's turn loop).
 *   - Uses the cheapest available model (the provider's `model` parameter is
 *     set by the kernel from `provider_configs.model_tone_rewrite`).
 *   - The rewrite prompt is minimal: it passes the effective cascade MD as a
 *     system instruction and the draft as the user message, requesting a
 *     tone-adjusted reply that preserves all factual content.
 */

import { checkSubstanceDiff } from './substance-diff.js';

import type { ProviderInterface, SoulCascade, ToneRewriteResult } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PREAMBLE = `You are a tone-rewrite assistant.

Your ONLY job is to rewrite the reply below to match the voice described in the
SOUL VOICE section.  You MUST preserve every factual claim, number, date, name,
code snippet, and URL exactly as they appear in the original.  The content must
not change — only the tone, word choice, and phrasing.

If the original is already consistent with the requested voice, output it
unchanged.

Output ONLY the rewritten reply.  No preamble, no commentary, no explanation.`;

function buildSystemPrompt(cascade: SoulCascade): string {
  return `${SYSTEM_PREAMBLE}

## SOUL VOICE

${cascade.effectiveMd}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rewrite `draftMarkdown` through the cascade's voice using the injected
 * provider, then guard the result with the substance-diff check.
 *
 * @param draftMarkdown - The agent's raw reply before tone adjustment.
 * @param cascade       - The resolved soul cascade for this turn.
 * @param provider      - An injected `ProviderInterface` (never resolved here).
 * @param model         - The model to use for the rewrite (cheaper model).
 * @param signal        - Optional abort signal.
 *
 * @returns `ToneRewriteResult` with `accepted` true when safe to deliver,
 *          false when the guard detected a factual change.
 */
export async function applyTone(
  draftMarkdown: string,
  cascade: SoulCascade,
  provider: ProviderInterface,
  model: string,
  signal?: AbortSignal,
): Promise<ToneRewriteResult> {
  const systemPrompt = buildSystemPrompt(cascade);

  // Collect the full rewritten text from the streaming provider.
  const chunks = provider.complete(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: draftMarkdown },
      ],
      temperature: 0.3,
    },
    signal,
  );

  let rewrittenMarkdown = '';
  for await (const chunk of chunks) {
    if (chunk.delta.content) {
      rewrittenMarkdown += chunk.delta.content;
    }
  }

  rewrittenMarkdown = rewrittenMarkdown.trim();

  // Guard: reject if facts changed.
  const diffResult = checkSubstanceDiff(draftMarkdown, rewrittenMarkdown);

  if (!diffResult.accepted) {
    const result: ToneRewriteResult = {
      rewrittenMarkdown,
      accepted: false,
    };
    if (diffResult.rejectionReason !== undefined) {
      result.rejectionReason = diffResult.rejectionReason;
    }
    return result;
  }

  return {
    rewrittenMarkdown,
    accepted: true,
  };
}
