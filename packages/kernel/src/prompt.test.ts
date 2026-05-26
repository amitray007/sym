import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, buildTurnContextPrompt, buildUserTurnContent } from './prompt.js';

import type { Turn } from '@sym/contracts';

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_01' as Turn['id'],
    workspaceId: 'ws_01' as Turn['workspaceId'],
    conversationId: 'conv_01' as Turn['conversationId'],
    entrySurface: 'app_mention',
    requester: 'U_alice' as Turn['requester'],
    channelId: 'C_general' as Turn['channelId'],
    text: 'Hello, Sym!',
    receivedAt: new Date('2026-05-24T00:00:00Z'),
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('returns a non-empty string containing "Sym"', () => {
    const prompt = buildSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Sym');
  });

  it('is stable across multiple calls (suitable for prompt-prefix caching)', () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
  });

  it('does not include runtime/volatile data', () => {
    const prompt = buildSystemPrompt();
    // System prompt must not contain turn IDs, user IDs, or channel IDs.
    expect(prompt).not.toContain('turn_');
    expect(prompt).not.toContain('U_alice');
    expect(prompt).not.toContain('C_general');
  });
});

describe('buildTurnContextPrompt', () => {
  it('includes requester, entry surface, channel, and timestamp', () => {
    const turn = makeTurn();
    const ctx = buildTurnContextPrompt(turn);
    expect(ctx).toContain('U_alice');
    expect(ctx).toContain('app_mention');
    expect(ctx).toContain('C_general');
    expect(ctx).toContain('2026-05-24');
  });

  it('includes threadTs when present', () => {
    const turn = makeTurn({ threadTs: '12345.6789' as Turn['threadTs'] });
    const ctx = buildTurnContextPrompt(turn);
    expect(ctx).toContain('12345.6789');
  });

  it('omits threadTs when absent', () => {
    const turn = makeTurn({ threadTs: undefined });
    const ctx = buildTurnContextPrompt(turn);
    expect(ctx).not.toContain('thread');
  });
});

describe('buildUserTurnContent', () => {
  it('includes the turn text', () => {
    const content = buildUserTurnContent(makeTurn());
    expect(content).toContain('Hello, Sym!');
  });

  it('wraps turn metadata in a context-only label', () => {
    const content = buildUserTurnContent(makeTurn());
    expect(content).toContain('turn metadata');
    expect(content).toContain('context only');
  });

  it('puts metadata before the message text', () => {
    const content = buildUserTurnContent(makeTurn());
    const metaIdx = content.indexOf('turn metadata');
    const textIdx = content.indexOf('Hello, Sym!');
    expect(metaIdx).toBeLessThan(textIdx);
  });
});
