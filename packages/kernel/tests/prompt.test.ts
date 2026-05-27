import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, buildTurnContextPrompt, buildUserTurnContent } from '../src/prompt.js';

import type { SlackThreadTs, SlackUserId, Turn } from '@sym/contracts';

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

  it('omits the owner line when no owner identity is supplied', () => {
    const content = buildUserTurnContent(makeTurn());
    expect(content).not.toContain('owner:');
  });

  it('embeds an "owner:" line with name, tz, and id when owner identity is supplied', () => {
    const content = buildUserTurnContent(makeTurn(), {
      userId: 'U042MBPUZ9N' as SlackUserId,
      displayName: 'Amit Ray',
      tz: 'Asia/Kolkata',
      title: 'Founder',
    });
    expect(content).toContain('owner: Amit Ray');
    expect(content).toContain('Asia/Kolkata');
    expect(content).toContain('Founder');
    expect(content).toContain('U042MBPUZ9N');
    // Owner sits INSIDE the metadata block, ABOVE the existing turn-meta line.
    const ownerIdx = content.indexOf('owner: Amit Ray');
    // makeTurn() sets requester=U_alice, so the routing line starts "from U_alice".
    const fromIdx = content.indexOf('from U_alice');
    expect(ownerIdx).toBeLessThan(fromIdx);
    // And the whole block precedes the user's actual text.
    const textIdx = content.indexOf('Hello, Sym!');
    expect(ownerIdx).toBeLessThan(textIdx);
  });

  it('falls back to real_name when display_name is missing, then to id when both are', () => {
    const fallbackName = buildUserTurnContent(makeTurn(), {
      userId: 'U042MBPUZ9N' as SlackUserId,
      realName: 'Amit Ray',
    });
    expect(fallbackName).toContain('owner: Amit Ray');

    const idOnly = buildUserTurnContent(makeTurn(), {
      userId: 'U042MBPUZ9N' as SlackUserId,
    });
    // When no name resolves, the id stands alone (no "— id" suffix dangling).
    expect(idOnly).toContain('owner: U042MBPUZ9N');
    expect(idOnly).not.toContain('— id U042MBPUZ9N');
  });
});
