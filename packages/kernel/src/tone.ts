import type { SoulCascade, ToneRewriteRequest, ToneRewriteResult } from '@sym/contracts';

/**
 * Tone-rewrite hook — identity stub until S7d ships.
 *
 * The stub passes `draftMarkdown` through unchanged and marks `accepted: true`.
 * When S7d wires the real tone-rewrite stage (with substance-diff guard), this
 * function is replaced. The kernel calls this hook after the draft is produced
 * and before the `Reply` is assembled.
 */
export function applyToneRewrite(_cascade: SoulCascade, draftMarkdown: string): ToneRewriteResult {
  const req: ToneRewriteRequest = {
    draftMarkdown,
    cascade: _cascade,
  };

  return {
    rewrittenMarkdown: req.draftMarkdown,
    accepted: true,
  };
}
