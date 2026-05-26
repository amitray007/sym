import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, buildTurnContextPrompt, buildUserTurnContent } from '../src/prompt.js';

import type { SlackThreadTs, Turn } from '@sym/contracts';

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return Object.assign(
    {
      id: 'turn_01',
      workspaceId: 'ws_01',
      conversationId: 'conv_01',
      entrySurface: 'app_mention' as const,
      requester: 'U_alice',
      channelId: 'C_general',
      text: 'Hello, Sym!',
      receivedAt: new Date('2026-05-24T00:00:00Z'),
    },
    overrides,
  ) as Turn;
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
    const turn = makeTurn({ threadTs: '12345.6789' as SlackThreadTs });
    const ctx = buildTurnContextPrompt(turn);
    expect(ctx).toContain('12345.6789');
  });

  it('omits threadTs when absent', () => {
    const turn = makeTurn();
    delete (turn as Partial<Turn>).threadTs;
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
