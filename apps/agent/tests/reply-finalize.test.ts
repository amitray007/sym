import { describe, expect, it } from 'vitest';

import { PlanController } from '../src/plan-controller.js';
import { clipNotif, heroRenderParts, needsLlmCleanup } from '../src/reply-finalize.js';

import type { Reply, TurnId } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReply(overrides: Partial<Reply> = {}): Reply {
  return {
    turnId: 'turn-1' as TurnId,
    markdown: 'Hello world',
    receipt: {
      turnId: 'turn-1' as TurnId,
      model: 'test-model',
      toolsInvoked: [],
      durationMs: 10,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clipNotif
// ---------------------------------------------------------------------------

describe('clipNotif', () => {
  it('returns the text unchanged when under the limit', () => {
    const text = 'Hello world';
    expect(clipNotif(text)).toBe(text);
  });

  it('truncates and appends ellipsis when over the 39k limit', () => {
    const longText = 'x'.repeat(40_000);
    const result = clipNotif(longText);
    expect(result.length).toBe(39_000);
    expect(result.endsWith('…')).toBe(true);
  });

  it('returns text exactly at the limit unchanged', () => {
    const text = 'x'.repeat(39_000);
    expect(clipNotif(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// needsLlmCleanup
// ---------------------------------------------------------------------------

describe('needsLlmCleanup', () => {
  it('returns false for a no-tool, no-plan reply', () => {
    const plan = new PlanController();
    const reply = makeReply({
      receipt: { turnId: 'turn-1' as TurnId, model: 'm', toolsInvoked: [], durationMs: 1 },
    });
    expect(needsLlmCleanup(reply, plan)).toBe(false);
  });

  it('returns true when at least one tool was invoked', () => {
    const plan = new PlanController();
    const reply = makeReply({
      receipt: {
        turnId: 'turn-1' as TurnId,
        model: 'm',
        toolsInvoked: ['get_time'],
        durationMs: 1,
      },
    });
    expect(needsLlmCleanup(reply, plan)).toBe(true);
  });

  it('returns true when a plan is active (even without tools)', async () => {
    const plan = new PlanController();
    await plan.setPlan(['step one']);
    const reply = makeReply({
      receipt: { turnId: 'turn-1' as TurnId, model: 'm', toolsInvoked: [], durationMs: 1 },
    });
    expect(needsLlmCleanup(reply, plan)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// heroRenderParts
// ---------------------------------------------------------------------------

describe('heroRenderParts', () => {
  it('returns empty blocks and empty suffix when no renders', () => {
    const reply = makeReply();
    const { renderBlocks, fallbackSuffix } = heroRenderParts(reply);
    expect(renderBlocks).toEqual([]);
    expect(fallbackSuffix).toBe('');
  });

  it('returns empty blocks and empty suffix when renders array is empty', () => {
    const reply = makeReply({ renders: [] });
    const { renderBlocks, fallbackSuffix } = heroRenderParts(reply);
    expect(renderBlocks).toEqual([]);
    expect(fallbackSuffix).toBe('');
  });

  it('renders the last intent when multiple are present (over-render signal)', () => {
    // Two table intents — only the last is shown.
    const reply = makeReply({
      renders: [
        {
          kind: 'table',
          columns: [{ header: 'A' }],
          rows: [[{ text: '1' }]],
        },
        {
          kind: 'table',
          columns: [{ header: 'B' }],
          rows: [[{ text: '2' }]],
        },
      ],
    });
    const { renderBlocks } = heroRenderParts(reply);
    // renderIntentToBlocks produces at least one block for a table.
    expect(renderBlocks.length).toBeGreaterThan(0);
  });

  it('non-empty fallbackSuffix for a table intent (fallback text is derived)', () => {
    const reply = makeReply({
      renders: [
        {
          kind: 'table',
          columns: [{ header: 'Col' }],
          rows: [[{ text: 'val' }]],
        },
      ],
    });
    const { fallbackSuffix } = heroRenderParts(reply);
    expect(fallbackSuffix).not.toBe('');
    expect(fallbackSuffix.startsWith('\n\n')).toBe(true);
  });
});
