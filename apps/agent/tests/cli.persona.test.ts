/**
 * `sym persona` — read-only introspection over the persona roster + home voice.
 * Captures console output in-process and asserts the rendered roster + `--json`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { personaCommand } from '../src/cli/commands/persona.js';

describe('personaCommand', () => {
  let log: string[];
  let err: string[];
  let savedPersona: string | undefined;

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
    delete process.env['SYM_PERSONA'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedPersona === undefined) delete process.env['SYM_PERSONA'];
    else process.env['SYM_PERSONA'] = savedPersona;
  });

  it('lists every voice and marks Sym as home by default', () => {
    const code = personaCommand([], false);
    expect(code).toBe(0);
    const out = log.join('\n');
    for (const label of ['Sym', 'Operator', 'Sensei', 'Concierge', 'Hype', 'Goblin', 'Noir']) {
      expect(out).toContain(label);
    }
    expect(out).toContain('Home: Sym');
    expect(out).toMatch(/●\s+Sym/); // the home marker sits on the Sym row
  });

  it('reports the configured home voice from SYM_PERSONA (case-insensitive)', () => {
    process.env['SYM_PERSONA'] = 'Concierge';
    personaCommand([], false);
    const out = log.join('\n');
    expect(out).toContain('Home: Concierge');
    expect(out).toMatch(/●\s+Concierge/);
  });

  it('show <name> prints that one persona', () => {
    const code = personaCommand(['show', 'goblin'], false);
    expect(code).toBe(0);
    expect(log.join('\n')).toContain('Goblin');
  });

  it('show with no name defaults to the home voice', () => {
    process.env['SYM_PERSONA'] = 'operator';
    personaCommand(['show'], false);
    const out = log.join('\n');
    expect(out).toContain('Operator');
    expect(out).toContain('(home)');
  });

  it('show with an unknown persona errors and returns 1', () => {
    const code = personaCommand(['show', 'wizard'], false);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain("unknown persona 'wizard'");
  });

  it('rejects an unknown subcommand', () => {
    const code = personaCommand(['frobnicate'], false);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('unknown');
  });

  it('--json emits the full roster with the home flag set', () => {
    process.env['SYM_PERSONA'] = 'hype';
    const code = personaCommand([], true);
    expect(code).toBe(0);
    const parsed = JSON.parse(log.join('')) as {
      home: string;
      personas: { name: string; label: string; blurb: string; home: boolean }[];
    };
    expect(parsed.home).toBe('hype');
    expect(parsed.personas).toHaveLength(7);
    expect(parsed.personas.find((p) => p.name === 'hype')?.home).toBe(true);
    expect(parsed.personas.find((p) => p.name === 'sym')?.home).toBe(false);
  });

  it('--json show emits one persona with name/label/blurb/home', () => {
    process.env['SYM_PERSONA'] = 'operator';
    const code = personaCommand(['show', 'operator'], true);
    expect(code).toBe(0);
    const p = JSON.parse(log.join('')) as {
      name: string;
      label: string;
      blurb: string;
      home: boolean;
    };
    expect(p).toMatchObject({ name: 'operator', label: 'Operator', home: true });
    expect(p.blurb.length).toBeGreaterThan(0);
  });
});
