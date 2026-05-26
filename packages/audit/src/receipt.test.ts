import { describe, expect, it } from 'vitest';

import { auditEventsToReceipt, receiptForTurn, type AuditEventRow } from './receipt.js';

import type { TurnId, WorkspaceId } from '@sym/contracts';

const WS = 'ws_test' as WorkspaceId;
const TURN_ID = 'turn_abc' as TurnId;

function makeEvent(overrides: Partial<AuditEventRow> & { kind: string }): AuditEventRow {
  return {
    id: 1,
    workspaceId: WS,
    kind: overrides.kind,
    actorKind: 'system',
    actorId: 'system',
    payload: {},
    ts: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('auditEventsToReceipt', () => {
  it('returns a minimal receipt for empty events', () => {
    const r = auditEventsToReceipt(TURN_ID, []);
    expect(r.turnId).toBe(TURN_ID);
    expect(r.model).toBe('unknown');
    expect(r.toolsInvoked).toEqual([]);
    expect(r.usage).toBeUndefined();
    expect(r.durationMs).toBeUndefined();
  });

  it('extracts model from gen_ai.completion payload', () => {
    const ev = makeEvent({
      kind: 'gen_ai.completion',
      payload: {
        model: 'fireworks/llama-3.1-70b',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    });
    const r = auditEventsToReceipt(TURN_ID, [ev]);
    expect(r.model).toBe('fireworks/llama-3.1-70b');
  });

  it('defaults model to "unknown" when no gen_ai.completion event', () => {
    const ev = makeEvent({ kind: 'app.turn.complete', payload: {} });
    const r = auditEventsToReceipt(TURN_ID, [ev]);
    expect(r.model).toBe('unknown');
  });

  it('sums usage across multiple gen_ai.completion events', () => {
    const ev1 = makeEvent({
      id: 1,
      kind: 'gen_ai.completion',
      payload: { model: 'm', promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      ts: new Date('2026-01-01T00:00:01.000Z'),
    });
    const ev2 = makeEvent({
      id: 2,
      kind: 'gen_ai.completion',
      payload: { model: 'm', promptTokens: 200, completionTokens: 80, totalTokens: 280 },
      ts: new Date('2026-01-01T00:00:02.000Z'),
    });
    const r = auditEventsToReceipt(TURN_ID, [ev1, ev2]);
    expect(r.usage?.promptTokens).toBe(300);
    expect(r.usage?.completionTokens).toBe(130);
    expect(r.usage?.totalTokens).toBe(430);
  });

  it('computes durationMs from first to last event timestamp', () => {
    const ev1 = makeEvent({
      id: 1,
      kind: 'app.turn.complete',
      ts: new Date('2026-01-01T00:00:00.000Z'),
    });
    const ev2 = makeEvent({
      id: 2,
      kind: 'gen_ai.completion',
      payload: { model: 'm' },
      ts: new Date('2026-01-01T00:00:05.250Z'),
    });
    const r = auditEventsToReceipt(TURN_ID, [ev2, ev1]); // out of order input
    expect(r.durationMs).toBe(5250);
  });

  it('collects tools invoked from app.tool.invoke events', () => {
    const ev1 = makeEvent({ id: 1, kind: 'app.tool.invoke', payload: { toolName: 'bash' } });
    const ev2 = makeEvent({ id: 2, kind: 'app.tool.invoke', payload: { toolName: 'web_search' } });
    const ev3 = makeEvent({ id: 3, kind: 'app.tool.invoke', payload: { toolName: 'bash' } }); // duplicate
    const r = auditEventsToReceipt(TURN_ID, [ev1, ev2, ev3]);
    expect(r.toolsInvoked.sort()).toEqual(['bash', 'web_search']);
  });

  it('collects tools invoked from execute_tool kinds', () => {
    const ev = makeEvent({ kind: 'gen_ai.execute_tool', payload: { toolName: 'gh' } });
    const r = auditEventsToReceipt(TURN_ID, [ev]);
    expect(r.toolsInvoked).toEqual(['gh']);
  });

  it('picks up onBehalfOf from the first event that has it', () => {
    const ev1 = makeEvent({ id: 1, kind: 'app.turn.complete', payload: {} });
    const ev2 = makeEvent({ id: 2, kind: 'gen_ai.completion', payload: { model: 'm' } });
    (ev2 as AuditEventRow).onBehalfOf = 'U_delegate' as AuditEventRow['onBehalfOf'];
    const r = auditEventsToReceipt(TURN_ID, [ev1, ev2]);
    expect(r.onBehalfOf).toBe('U_delegate');
  });
});

describe('receiptForTurn', () => {
  it('filters events by payload.turnId', () => {
    const ev1 = makeEvent({
      id: 1,
      kind: 'gen_ai.completion',
      payload: {
        model: 'm',
        turnId: TURN_ID,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    });
    const ev2 = makeEvent({
      id: 2,
      kind: 'gen_ai.completion',
      payload: {
        model: 'm2',
        turnId: 'turn_other',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    });
    const r = receiptForTurn(TURN_ID, [ev1, ev2]);
    expect(r.model).toBe('m');
    expect(r.usage?.promptTokens).toBe(10);
  });

  it('returns empty receipt when no events match turnId', () => {
    const ev = makeEvent({
      kind: 'gen_ai.completion',
      payload: { model: 'm', turnId: 'turn_other' },
    });
    const r = receiptForTurn(TURN_ID, [ev]);
    expect(r.model).toBe('unknown');
  });
});
