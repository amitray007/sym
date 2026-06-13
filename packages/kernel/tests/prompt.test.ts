import { describe, expect, it } from 'vitest';

import { buildActivePersonaPrompt, PERSONA_SPECS } from '../src/persona-specs.js';
import {
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
    expect(sectionPersonas()[0]).toBe('## Your personas (one active voice per turn)');
  });

  it('sectionPersonas defines every voice (each pinned to its own bullet)', () => {
    const section = sectionPersonas().join('\n');
    for (const voice of ['Sym', 'Operator', 'Sensei', 'Concierge', 'Hype', 'Goblin', 'Noir']) {
      // Match the voice's definition bullet ("• <Name>"), not just any mention —
      // otherwise "Sym" passes trivially since it appears throughout the section.
      expect(section).toMatch(new RegExp(`•\\s+${voice}\\b`));
    }
  });

  it('sectionPersonas names Sym as the default voice', () => {
    const section = sectionPersonas().join('\n');
    expect(section).toMatch(/•\s+Sym\b/);
    expect(section).toContain('the default');
  });

  it('sectionPersonas scopes persona to prose, never structured surfaces', () => {
    const section = sectionPersonas().join('\n');
    expect(section).toContain('colors your PROSE only');
    expect(section).toContain('present_card');
  });

  it('sectionPersonas keeps the anti-sycophancy invariants across every persona', () => {
    expect(sectionPersonas().join('\n')).toContain('still obeys the Voice and style rules');
  });

  it('sectionPersonas keeps the hard safety floor (no bit when venting, never roast a person)', () => {
    const section = sectionPersonas().join('\n');
    expect(section).toContain('Hard overrides');
    expect(section).toContain('No Goblin snark');
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

  it('sectionPersonas references the Active persona block but does not embed a full spec', () => {
    const section = sectionPersonas().join('\n');
    expect(section).toContain('Active persona'); // references the injected block by name
    expect(section).not.toContain('You are Sym in'); // the rich spec is injected separately
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
// Persona registry + specs + active-persona prompt
// ---------------------------------------------------------------------------

describe('persona registry + specs', () => {
  it('PERSONA_NAMES lists every voice in display order, with Sym as the default', () => {
    expect(PERSONA_NAMES).toEqual([
      'sym',
      'operator',
      'sensei',
      'concierge',
      'hype',
      'goblin',
      'noir',
    ]);
    expect(DEFAULT_PERSONA).toBe('sym');
  });

  it('every registry label appears verbatim in the prose persona section (no drift)', () => {
    const prose = sectionPersonas().join('\n');
    for (const name of PERSONA_NAMES) {
      expect(PERSONAS[name].label.length).toBeGreaterThan(0);
      expect(prose).toContain(PERSONAS[name].label);
    }
  });

  it('PERSONA_SPECS has a rich, situation-aware spec for every voice', () => {
    for (const name of PERSONA_NAMES) {
      const spec = PERSONA_SPECS[name];
      expect(spec.length).toBeGreaterThan(200); // rich, not a one-liner
      expect(spec).toContain('Per situation'); // covers behaviour across situations
    }
  });

  it('playful voices restate their safety guardrail in-spec (belt-and-suspenders with the base floor)', () => {
    expect(PERSONA_SPECS.goblin).toMatch(/never roast a real person/i);
    expect(PERSONA_SPECS.goblin).toMatch(/drop the bit/i);
    expect(PERSONA_SPECS.noir).toMatch(/never roast a real person/i);
  });

  it('flavorful voices keep structured surfaces neutral in-spec, and Hype restates the shared-channel floor', () => {
    // The no-bleed guard lives in the base prompt; echo it in the specs most prone
    // to leaking flavor so it survives a model downgrade.
    for (const name of ['goblin', 'hype', 'noir'] as const) {
      expect(PERSONA_SPECS[name]).toMatch(/PROSE only/);
    }
    // Hype carries the DM-only-on-own-initiative floor (with the invited/homed carve-out).
    expect(PERSONA_SPECS.hype).toMatch(/DM-only on your own initiative/);
  });

  it('buildActivePersonaPrompt wraps the active voice in an Active persona block', () => {
    const block = buildActivePersonaPrompt('concierge');
    expect(block).toContain('## Active persona — Concierge');
    expect(block).toContain(PERSONA_SPECS['concierge'].trim());
  });

  it('buildActivePersonaPrompt injects a spec for the default persona too (no empty case)', () => {
    const block = buildActivePersonaPrompt('sym');
    expect(block).toContain('## Active persona — Sym');
    expect(block.length).toBeGreaterThan(200);
  });

  it('buildActivePersonaPrompt accepts an override spec in place of the default', () => {
    const block = buildActivePersonaPrompt('goblin', 'CUSTOM GOBLIN SPEC');
    expect(block).toContain('## Active persona — Goblin');
    expect(block).toContain('CUSTOM GOBLIN SPEC');
    expect(block).not.toContain(PERSONA_SPECS['goblin']);
  });

  it('buildActivePersonaPrompt frames the voice as the owner-configured home (the "explicit invite")', () => {
    // The non-editable provenance line is present even under a custom override, so
    // a playful home reads as owner-sanctioned, not the model's own initiative.
    const block = buildActivePersonaPrompt('goblin', 'CUSTOM GOBLIN SPEC');
    expect(block).toContain('owner-configured home voice');
    expect(block).toContain('explicit invite');
    expect(block).toContain('CUSTOM GOBLIN SPEC');
  });

  it('the invite provenance is scoped to the playful voices only (clean block for the rest)', () => {
    // Goblin/Hype carry a DM-only floor the provenance reconciles…
    expect(buildActivePersonaPrompt('goblin')).toContain('owner-configured home voice');
    expect(buildActivePersonaPrompt('hype')).toContain('owner-configured home voice');
    // …the rest have no such floor, so no meta-preamble — it would only risk priming
    // an over-formal register, especially on the default Sym voice.
    expect(buildActivePersonaPrompt('sym')).not.toContain('owner-configured home voice');
    expect(buildActivePersonaPrompt('concierge')).not.toContain('owner-configured home voice');
    expect(buildActivePersonaPrompt('operator')).not.toContain('owner-configured home voice');
  });

  it('the SHARED-channel floor reconciles a playful HOME voice as the invite (homing = invite)', () => {
    const section = sectionPersonas().join('\n');
    // A playful voice that is the configured home is sanctioned in a shared channel…
    expect(section).toContain('owner-configured home for this channel/deployment');
    // …but reaching for a playful voice on the model's own initiative is still blocked.
    expect(section).toMatch(/never REACH for Goblin/);
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
