/**
 * Tests for buildReceipt — kernel execution receipt builder.
 *
 * Pins:
 *   - required fields (turnId, model, toolsInvoked) always present
 *   - optional fields (usage, durationMs) present only when supplied
 *   - toolsInvoked empty vs non-empty
 *   - durationMs boundary (0 is a valid value → must be present when set)
 */

import { describe, expect, it } from 'vitest';

import { buildReceipt } from '../src/receipt.js';

import type {
  ConversationId,
  SlackChannelId,
  SlackUserId,
  Turn,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_receipt_01' as TurnId,
    workspaceId: 'ws_01' as WorkspaceId,
    conversationId: 'ws_01:C1' as ConversationId,
    entrySurface: 'app_mention',
    requester: 'U_alice' as SlackUserId,
    channelId: 'C1' as SlackChannelId,
    text: 'Hello',
    receivedAt: new Date('2026-05-24T12:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildReceipt
// ---------------------------------------------------------------------------

describe('buildReceipt', () => {
  it('includes turnId, model, and toolsInvoked in every receipt', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'accounts/fireworks/models/test-model',
      toolsInvoked: [],
    });
    expect(receipt.turnId).toBe('turn_receipt_01');
    expect(receipt.model).toBe('accounts/fireworks/models/test-model');
    expect(receipt.toolsInvoked).toEqual([]);
  });

  it('includes toolsInvoked when tools were used', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: ['search_messages', 'read_channel', 'set_plan'],
    });
    expect(receipt.toolsInvoked).toEqual(['search_messages', 'read_channel', 'set_plan']);
  });

  it('omits usage when not supplied (exactOptionalPropertyTypes)', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: [],
    });
    // The key must be absent, not present as `undefined`.
    expect('usage' in receipt).toBe(false);
  });

  it('includes usage when supplied', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    expect(receipt.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it('omits durationMs when not supplied', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: [],
    });
    expect('durationMs' in receipt).toBe(false);
  });

  it('includes durationMs when supplied (including 0 as a valid boundary)', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: [],
      durationMs: 0,
    });
    expect(receipt.durationMs).toBe(0);
    expect('durationMs' in receipt).toBe(true);
  });

  it('includes durationMs for a typical value', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: ['get_current_time'],
      durationMs: 1234,
    });
    expect(receipt.durationMs).toBe(1234);
  });

  it('includes both usage and durationMs when both are supplied', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: ['run_cli'],
      usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
      durationMs: 3500,
    });
    expect(receipt.usage?.totalTokens).toBe(280);
    expect(receipt.durationMs).toBe(3500);
  });

  it('turnId comes from the turn, not a separate field', () => {
    const turn = makeTurn({ id: 'turn_custom_99' as TurnId });
    const receipt = buildReceipt({
      turn,
      model: 'test-model',
      toolsInvoked: [],
    });
    expect(receipt.turnId).toBe('turn_custom_99');
  });

  it('toolsInvoked order is preserved', () => {
    const receipt = buildReceipt({
      turn: makeTurn(),
      model: 'test-model',
      toolsInvoked: ['a', 'b', 'c', 'd'],
    });
    expect(receipt.toolsInvoked).toEqual(['a', 'b', 'c', 'd']);
  });
});
