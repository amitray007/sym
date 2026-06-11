/**
 * `sym persona` — voice introspection + per-channel home overrides. Captures
 * console output in-process; uses an in-memory settings store for the channel
 * verbs (reset between tests) so nothing leaks to disk.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetChannelPersonaStoreForTesting } from '@sym/mcp-runtime';

import { personaCommand } from '../src/cli/commands/persona.js';

describe('personaCommand', () => {
  let log: string[];
  let err: string[];
  let savedPersona: string | undefined;
  let savedSettingsDb: string | undefined;
  let savedPersonasDir: string | undefined;
  let personasDir: string;
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    log = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      log.push(a.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      err.push(a.join(' '));
    });
    savedPersona = process.env['SYM_PERSONA'];
    savedSettingsDb = process.env['SYM_SETTINGS_DB_PATH'];
    savedPersonasDir = process.env['SYM_PERSONAS_DIR'];
    delete process.env['SYM_PERSONA'];
    // Channel verbs hit the settings store — point it at an in-memory DB and
    // reset the singleton so each test starts empty.
    process.env['SYM_SETTINGS_DB_PATH'] = ':memory:';
    // Spec overrides write files — point them at a throwaway temp dir.
    personasDir = mkdtempSync(join(tmpdir(), 'sym-personas-'));
    process.env['SYM_PERSONAS_DIR'] = personasDir;
    // Force non-TTY so `edit` never tries to spawn a real $EDITOR (would hang).
    savedIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    _resetChannelPersonaStoreForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetChannelPersonaStoreForTesting();
    restore('SYM_PERSONA', savedPersona);
    restore('SYM_SETTINGS_DB_PATH', savedSettingsDb);
    restore('SYM_PERSONAS_DIR', savedPersonasDir);
    rmSync(personasDir, { recursive: true, force: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedIsTTY, configurable: true });
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  // --- roster + show ---

  it('lists every voice and marks Sym as home by default', async () => {
    const code = await personaCommand([], false);
    expect(code).toBe(0);
    const out = log.join('\n');
    for (const label of ['Sym', 'Operator', 'Sensei', 'Concierge', 'Hype', 'Goblin', 'Noir']) {
      expect(out).toContain(label);
    }
    expect(out).toContain('Home: Sym');
    expect(out).toMatch(/●\s+Sym/);
  });

  it('reports the configured home voice from SYM_PERSONA (case-insensitive)', async () => {
    process.env['SYM_PERSONA'] = 'Concierge';
    await personaCommand([], false);
    const out = log.join('\n');
    expect(out).toContain('Home: Concierge');
    expect(out).toMatch(/●\s+Concierge/);
  });

  it('show <name> prints that one persona', async () => {
    expect(await personaCommand(['show', 'goblin'], false)).toBe(0);
    expect(log.join('\n')).toContain('Goblin');
  });

  it('show with no name defaults to the home voice', async () => {
    process.env['SYM_PERSONA'] = 'operator';
    await personaCommand(['show'], false);
    const out = log.join('\n');
    expect(out).toContain('Operator');
    expect(out).toContain('(home)');
  });

  it('show with an unknown persona errors and returns 1', async () => {
    expect(await personaCommand(['show', 'wizard'], false)).toBe(1);
    expect(err.join('\n')).toContain("unknown persona 'wizard'");
  });

  it('rejects an unknown subcommand', async () => {
    expect(await personaCommand(['frobnicate'], false)).toBe(1);
    expect(err.join('\n')).toContain('unknown');
  });

  it('--json emits the full roster with the home flag set', async () => {
    process.env['SYM_PERSONA'] = 'hype';
    expect(await personaCommand([], true)).toBe(0);
    const parsed = JSON.parse(log.join('')) as {
      home: string;
      personas: { name: string; label: string; blurb: string; home: boolean }[];
    };
    expect(parsed.home).toBe('hype');
    expect(parsed.personas).toHaveLength(7);
    expect(parsed.personas.find((p) => p.name === 'hype')?.home).toBe(true);
    expect(parsed.personas.find((p) => p.name === 'sym')?.home).toBe(false);
  });

  it('--json show emits one persona with name/label/blurb/home', async () => {
    process.env['SYM_PERSONA'] = 'operator';
    expect(await personaCommand(['show', 'operator'], true)).toBe(0);
    const p = JSON.parse(log.join('')) as {
      name: string;
      label: string;
      blurb: string;
      home: boolean;
    };
    expect(p).toMatchObject({ name: 'operator', label: 'Operator', home: true });
    expect(p.blurb.length).toBeGreaterThan(0);
  });

  // --- per-channel overrides ---

  it('set stores a channel override, channels lists it, unset removes it', async () => {
    expect(await personaCommand(['set', 'C_eng', 'goblin'], false)).toBe(0);
    expect(log.join('\n')).toContain('C_eng → Goblin');

    log.length = 0;
    expect(await personaCommand(['channels'], false)).toBe(0);
    expect(log.join('\n')).toContain('C_eng');
    expect(log.join('\n')).toContain('Goblin');

    log.length = 0;
    expect(await personaCommand(['unset', 'C_eng'], false)).toBe(0);
    expect(log.join('\n')).toContain('unset C_eng');

    log.length = 0;
    expect(await personaCommand(['channels'], false)).toBe(0);
    expect(log.join('\n')).toContain('No per-channel overrides');
  });

  it('set rejects an unknown persona', async () => {
    expect(await personaCommand(['set', 'C_eng', 'wizard'], false)).toBe(1);
    expect(err.join('\n')).toContain("unknown persona 'wizard'");
  });

  it('set with missing args errors', async () => {
    expect(await personaCommand(['set', 'C_eng'], false)).toBe(1);
    expect(err.join('\n')).toContain('usage');
  });

  it('unset on an unknown channel reports no override', async () => {
    expect(await personaCommand(['unset', 'C_nope'], false)).toBe(0);
    expect(log.join('\n')).toContain('no override for C_nope');
  });

  it('channels --json emits the overrides', async () => {
    await personaCommand(['set', 'C_exec', 'concierge'], false);
    log.length = 0;
    expect(await personaCommand(['channels'], true)).toBe(0);
    const parsed = JSON.parse(log.join('')) as {
      channelId: string;
      persona: string;
      label: string;
    }[];
    expect(parsed).toEqual([{ channelId: 'C_exec', persona: 'concierge', label: 'Concierge' }]);
  });

  // --- editable spec overrides ---

  it('show <name> prints the effective spec (the default when not customized)', async () => {
    expect(await personaCommand(['show', 'operator'], false)).toBe(0);
    const out = log.join('\n');
    expect(out).toContain('Operator');
    expect(out).toContain('deadpan'); // from the default Operator spec body
    expect(out).toContain('default —'); // marked as using the default
  });

  it('reset with no override reports the persona already uses the default', async () => {
    expect(await personaCommand(['reset', 'goblin'], false)).toBe(0);
    expect(log.join('\n')).toContain('already uses the default spec');
  });

  it('edit needs a terminal and writes nothing off-TTY (just points at the path)', async () => {
    expect(await personaCommand(['edit', 'goblin'], false)).toBe(1); // non-TTY guard
    expect(err.join('\n')).toContain('goblin.md');
    expect(existsSync(join(personasDir, 'goblin.md'))).toBe(false); // no file written off-TTY
  });

  it('show marks a persona customized and prints the override when one exists', async () => {
    writeFileSync(join(personasDir, 'goblin.md'), 'CUSTOM GOBLIN SPEC', 'utf8');
    await personaCommand(['show', 'goblin'], false);
    const out = log.join('\n');
    expect(out).toContain('customized');
    expect(out).toContain('CUSTOM GOBLIN SPEC');
  });

  it('reset removes an existing override and reports it', async () => {
    writeFileSync(join(personasDir, 'hype.md'), 'CUSTOM', 'utf8');
    expect(await personaCommand(['reset', 'hype'], false)).toBe(0);
    expect(log.join('\n')).toContain('reset Hype to its default spec');
    expect(existsSync(join(personasDir, 'hype.md'))).toBe(false);
  });

  it('rejects edit/reset for an unknown persona', async () => {
    expect(await personaCommand(['edit', 'wizard'], false)).toBe(1);
    expect(await personaCommand(['reset', 'wizard'], false)).toBe(1);
    expect(err.join('\n')).toContain('usage');
  });
});
