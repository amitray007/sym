/**
 * Reply finalization helpers — shared by both delivery paths (streamed and
 * plain postMessage). Decides whether the LLM cleanup backstop runs, produces
 * the final body, clips notification text under Slack's limit, and renders the
 * turn's single "hero" structured surface.
 */

import { renderIntentToBlocks, renderIntentToFallbackText } from '@sym/adapter-slack';

import { logCtx } from './log.js';
import { cleanupReply } from './reply-cleanup.js';

import type { HandleTurnDeps } from './handle-turn.js';
import type { PlanController } from './plan-controller.js';
import type { SlackBlock } from '@sym/adapter-slack';
import type { Reply } from '@sym/contracts';

/** Cap the notification/fallback `text` param under Slack's ~40k limit. */
export function clipNotif(text: string): string {
  const MAX = 39_000;
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

/**
 * Whether to run the LLM cleanup backstop. The model narrates its STEPS
 * whenever it's doing things, so narration tracks *any* tool use — not the tool
 * COUNT. (Observed 2026-05-30: a turn that narrated a whole fake p1/p2/p3 plan
 * while actually invoking just `get_current_time` slipped past a `> 1` gate.)
 * Run whenever a plan was set OR at least one tool ran. Pure no-tool text
 * replies ("hello") have nothing to narrate, so they skip the extra call. This
 * gate is STRUCTURAL — it never inspects the reply text — so it still fires on
 * narration phrasings we've never seen.
 */
export function needsLlmCleanup(reply: Reply, planController: PlanController): boolean {
  return planController.isActive() || reply.receipt.toolsInvoked.length > 0;
}

/**
 * Body for the non-streamed paths: span-removal cleanup on multi-step turns,
 * the raw draft otherwise. `cleanupReply` fails open to the draft, so this
 * never loses the answer.
 */
export async function finalReplyBody(
  reply: Reply,
  planController: PlanController,
  deps: HandleTurnDeps,
): Promise<string> {
  if (needsLlmCleanup(reply, planController)) {
    return cleanupReply(reply.markdown, { fireworks: deps.fireworks, model: deps.model });
  }
  return reply.markdown;
}

/**
 * The turn's single "hero" render. A turn may collect multiple render intents
 * (e.g. two searches); we surface only the LAST one — one structured surface
 * per message — and log the others as an over-render signal. Returns the blocks
 * to splice beneath the markdown body and a fallback-text suffix carrying the
 * same content for notifications + screen readers.
 */
export function heroRenderParts(reply: Reply): {
  renderBlocks: SlackBlock[];
  fallbackSuffix: string;
} {
  const renders = reply.renders;
  if (renders === undefined || renders.length === 0) {
    return { renderBlocks: [], fallbackSuffix: '' };
  }
  if (renders.length > 1) {
    console.info(
      `${logCtx(reply.turnId)} [render] ${renders.length} intents this turn; using last (over-render signal)`,
    );
  }
  const hero = renders[renders.length - 1]!;
  return {
    renderBlocks: renderIntentToBlocks(hero),
    fallbackSuffix: `\n\n${renderIntentToFallbackText(hero)}`,
  };
}
