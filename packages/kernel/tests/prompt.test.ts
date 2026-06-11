import { describe, expect, it } from 'vitest';

import {
  buildHomePersonaOverride,
  buildSystemPrompt,
  buildTurnContextPrompt,
  buildUserTurnContent,
  DEFAULT_PERSONA,
  isPersonaName,
  PERSONA_NAMES,
  PERSONAS,
  resolvePersona,
  sectionHowYouWork,
  sectionOwnerRelationship,
  sectionPersonas,
  sectionPlanning,
  sectionReplyDiscipline,
  sectionVoiceAndStyle,
} from '../src/prompt.js';

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

  it('marks a channel mention as SHARED visibility', () => {
    const ctx = buildTurnContextPrompt(makeTurn({ entrySurface: 'app_mention' }));
    expect(ctx).toContain('SHARED');
  });

  it('marks a DM as PRIVATE visibility', () => {
    const ctx = buildTurnContextPrompt(makeTurn({ entrySurface: 'dm' }));
    expect(ctx).toContain('PRIVATE');
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
      userName: 'amit',
      displayName: 'Amit Ray',
      tz: 'Asia/Kolkata',
      title: 'Founder',
    });
    expect(content).toContain('owner: Amit Ray');
    expect(content).toContain('@amit');
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

// ---------------------------------------------------------------------------
// Named section extractors
// ---------------------------------------------------------------------------

describe('section extractors', () => {
  it('sectionOwnerRelationship returns the correct header', () => {
    const lines = sectionOwnerRelationship();
    expect(lines[0]).toBe('## Your relationship with the owner');
  });

  it('sectionOwnerRelationship content is present in the assembled prompt', () => {
    const prompt = buildSystemPrompt();
    for (const line of sectionOwnerRelationship()) {
      expect(prompt).toContain(line);
    }
  });

  it('sectionVoiceAndStyle starts with its header', () => {
    expect(sectionVoiceAndStyle()[0]).toBe('## Voice and style');
  });

  it('sectionVoiceAndStyle has at least 4 bullet lines', () => {
    const bullets = sectionVoiceAndStyle().filter((l) => l.startsWith('-'));
    expect(bullets.length).toBeGreaterThanOrEqual(4);
  });

  it('sectionPlanning enforces the single-outcome skip rule', () => {
    const section = sectionPlanning().join('\n');
    expect(section).toContain('SKIP planning for single-outcome');
  });

  it('sectionReplyDiscipline forbids narration-style text', () => {
    const section = sectionReplyDiscipline().join('\n');
    expect(section).toContain('NEVER write sentences like');
  });

  it('sectionPersonas starts with its header', () => {
    expect(sectionPersonas()[0]).toBe('## Your personas (one voice per reply — you pick it)');
  });

  it('sectionPersonas defines all six voices (each pinned to its own bullet)', () => {
    const section = sectionPersonas().join('\n');
    for (const voice of ['Sym', 'Operator', 'Sensei', 'Concierge', 'Hype', 'Goblin']) {
      // Match the voice's definition bullet ("• <Name>"), not just any mention —
      // otherwise "Sym" passes trivially since it appears throughout the section.
      expect(section).toMatch(new RegExp(`•\\s+${voice}\\b`));
    }
  });

  it('sectionPersonas names Sym as the home voice', () => {
    expect(sectionPersonas().join('\n')).toContain('HOME voice is Sym');
  });

  it('sectionPersonas scopes persona to prose, never structured surfaces', () => {
    const section = sectionPersonas().join('\n');
    expect(section).toContain('colors your PROSE only');
    expect(section).toContain('present_card');
  });

  it('sectionPersonas keeps the anti-sycophancy invariants across every persona', () => {
    expect(sectionPersonas().join('\n')).toContain('still obeys the Voice and style rules');
  });

  it('sectionPersonas enforces the hard overrides (no Goblin/Hype when venting, never roast a person)', () => {
    const section = sectionPersonas().join('\n');
    expect(section).toContain('Hard overrides');
    expect(section).toContain('never Goblin, never Hype');
    expect(section).toContain('never the human');
  });

  it('sectionHowYouWork routes a handed link to the right reader, not a reflex fetch_url', () => {
    const section = sectionHowYouWork().join('\n');
    expect(section).toContain('A LINK IS NOT AUTOMATICALLY A `fetch_url`');
    // Names the two better readers and demotes fetch_url to last resort.
    expect(section).toContain('read_thread');
    expect(section).toContain('find_tools');
    expect(section).toContain('LAST resort');
  });

  it('sectionPersonas keeps Sym (the bare home, no override) as the default voice', () => {
    // The prose section bakes in Sym; the home override lives outside it.
    expect(sectionPersonas().join('\n')).not.toContain('Active persona (deployment default)');
  });

  it('all section lines appear verbatim in buildSystemPrompt', () => {
    const prompt = buildSystemPrompt();
    const sections = [
      sectionOwnerRelationship(),
      sectionVoiceAndStyle(),
      sectionPersonas(),
      sectionPlanning(),
      sectionReplyDiscipline(),
    ];
    for (const section of sections) {
      for (const line of section) {
        expect(prompt, `line "${line.slice(0, 60)}…" should appear in prompt`).toContain(line);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Persona registry + home-persona override
// ---------------------------------------------------------------------------

describe('persona registry + home-persona override', () => {
  it('PERSONA_NAMES lists the six voices, with Sym as the default', () => {
    expect(PERSONA_NAMES).toEqual(['sym', 'operator', 'sensei', 'concierge', 'hype', 'goblin']);
    expect(DEFAULT_PERSONA).toBe('sym');
  });

  it('every registry label appears verbatim in the prose persona section (no drift)', () => {
    const prose = sectionPersonas().join('\n');
    for (const name of PERSONA_NAMES) {
      expect(PERSONAS[name].label.length).toBeGreaterThan(0);
      expect(prose).toContain(PERSONAS[name].label);
    }
  });

  it('buildHomePersonaOverride returns "" for the default persona (base prompt stays byte-stable)', () => {
    expect(buildHomePersonaOverride('sym')).toBe('');
  });

  it('buildHomePersonaOverride redirects the home voice for a non-default persona', () => {
    const block = buildHomePersonaOverride('concierge');
    expect(block).toContain('## Active persona (deployment default)');
    expect(block).toContain('Concierge');
    expect(block).toContain('HOME voice');
    // The override changes only the home voice — selection rules + overrides hold.
    expect(block).toContain('still apply');
  });

  it('every non-default persona yields a non-empty override naming its label', () => {
    for (const name of PERSONA_NAMES.filter((n) => n !== DEFAULT_PERSONA)) {
      const block = buildHomePersonaOverride(name);
      expect(block.length).toBeGreaterThan(0);
      expect(block).toContain(PERSONAS[name].label);
    }
  });

  it('isPersonaName guards valid ids', () => {
    expect(isPersonaName('operator')).toBe(true);
    expect(isPersonaName('wizard')).toBe(false);
    expect(isPersonaName('')).toBe(false);
  });

  it('resolvePersona trims, lowercases, and falls back to the default on unknown/empty/undefined', () => {
    expect(resolvePersona('concierge')).toBe('concierge');
    expect(resolvePersona('  GOBLIN ')).toBe('goblin');
    expect(resolvePersona('wizard')).toBe('sym');
    expect(resolvePersona('')).toBe('sym');
    expect(resolvePersona(undefined)).toBe('sym');
  });
});
