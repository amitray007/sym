import { markdownBlock, receiptToContextBlock } from '@sym/adapter-slack';
import { ToolRegistry, buildDefaultSoulCascade, runLoop } from '@sym/kernel';

import type { SlackClient } from '@sym/adapter-slack';
import type { ProviderInterface, Turn } from '@sym/contracts';

/** Injected dependencies for processing a turn (the testable seam). */
export interface HandleTurnDeps {
  provider: ProviderInterface;
  model: string;
  slackClient: SlackClient;
}

/**
 * The Milestone-1 path: run the kernel loop for a Turn and post the reply back
 * to Slack as a `markdown` block plus a receipt `context` footer. No tools yet
 * (empty registry), L0 default soul. Deps are injected so this is unit-testable
 * with a fake provider + mock Slack client.
 */
export async function handleTurn(turn: Turn, deps: HandleTurnDeps): Promise<void> {
  if (!turn.channelId) {
    console.warn(`[agent] turn ${turn.id} has no channelId; cannot reply`);
    return;
  }

  const cascade = buildDefaultSoulCascade();
  const registry = new ToolRegistry();
  const reply = await runLoop(turn, deps.provider, registry, cascade, { model: deps.model });

  const blocks = [markdownBlock(reply.markdown), receiptToContextBlock(reply.receipt)];

  await deps.slackClient.chatPostMessage({
    channel: turn.channelId,
    text: reply.markdown,
    blocks,
    // Reply in-thread when the turn is already threaded; top-level otherwise.
    ...(turn.threadTs !== undefined ? { thread_ts: turn.threadTs } : {}),
  });
}
