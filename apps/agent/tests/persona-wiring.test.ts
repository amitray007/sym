/**
 * Persona turn-boundary wiring — the composition runTurnLoop → runLoopPi performs
 * each turn, end to end (minus the model call):
 *
 *   effectiveHomePersona(channelId, globalHome)  →  loadPersonaSpec(persona)  →
 *   buildAgentSystemPrompt(…, persona, spec)  →  the "## Active persona" block.
 *
 * The three units are tested in isolation elsewhere; this proves they COMPOSE, so
 * a per-channel override and an edited `.sym/personas/<id>.md` spec actually reach
 * the assembled system prompt (the gap the review flagged: the seam was untested).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PERSONA_SPECS, type PersonaName } from '@sym/kernel';

import { effectiveHomePersona } from '../src/persona-resolve.js';
import { loadPersonaSpec, personaSpecPath } from '../src/persona-spec-loader.js';
import { buildAgentSystemPrompt } from '../src/pi/agent-setup.js';

/**
 * Compose exactly as the turn boundary does (run-turn-loop resolves the persona;
 * pi/loop loads the spec and builds the prompt). `lookup` is injected so the
 * per-channel resolution never touches SQLite.
 */
function assembleForTurn(
  channelId: string | undefined,
  globalHome: PersonaName | undefined,
  lookup: (channelId: string) => string | undefined,
): string {
  const persona = effectiveHomePersona(channelId, globalHome, lookup) ?? 'sym';
  return buildAgentSystemPrompt([], new Set([]), [], persona, loadPersonaSpec(persona));
}

describe('persona turn-boundary wiring', () => {
  let dir: string;
  let saved: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sym-personas-'));
    saved = process.env['SYM_PERSONAS_DIR'];
    process.env['SYM_PERSONAS_DIR'] = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['SYM_PERSONAS_DIR'];
    else process.env['SYM_PERSONAS_DIR'] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a per-channel override beats the global home and its spec reaches the system prompt', () => {
    const prompt = assembleForTurn('C_eng', 'sym', () => 'concierge');
    expect(prompt).toContain('## Active persona — Concierge');
    expect(prompt).toContain(PERSONA_SPECS.concierge.trim());
  });

  it('an edited .sym/personas/<id>.md override flows all the way through to the prompt', () => {
    writeFileSync(personaSpecPath('operator'), 'CUSTOM OPERATOR SPEC', 'utf8');
    const prompt = assembleForTurn('C_ops', undefined, () => 'operator');
    expect(prompt).toContain('## Active persona — Operator');
    expect(prompt).toContain('CUSTOM OPERATOR SPEC');
    expect(prompt).not.toContain(PERSONA_SPECS.operator.trim());
  });

  it('falls back to the global home, then to sym, when no channel override resolves', () => {
    expect(assembleForTurn('C_x', 'hype', () => undefined)).toContain('## Active persona — Hype');
    expect(assembleForTurn(undefined, undefined, () => undefined)).toContain(
      '## Active persona — Sym',
    );
  });

  it('the assembled active-persona block carries the home/invite provenance', () => {
    // The reconciliation from "homing = invite": even a playful per-channel home
    // is framed as owner-sanctioned in the prompt the model actually receives.
    const prompt = assembleForTurn('C_banter', 'sym', () => 'goblin');
    expect(prompt).toContain('## Active persona — Goblin');
    expect(prompt).toContain('owner-configured home voice');
    expect(prompt).toContain('explicit invite');
  });
});
