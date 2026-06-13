/**
 * persona-spec-loader — `.sym/personas/<id>.md` overrides over the kernel
 * defaults. Uses a throwaway temp dir per test so nothing leaks.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PERSONA_SPECS } from '@sym/kernel';

import {
  isPersonaCustomized,
  loadPersonaSpec,
  personaSpecPath,
  resetPersonaSpec,
  seedPersonaSpec,
} from '../src/persona-spec-loader.js';

describe('persona-spec-loader', () => {
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

  it('loadPersonaSpec returns the shipped default when no override exists', () => {
    expect(loadPersonaSpec('goblin')).toBe(PERSONA_SPECS.goblin);
    expect(isPersonaCustomized('goblin')).toBe(false);
  });

  it('loadPersonaSpec returns the override when one is present', () => {
    writeFileSync(personaSpecPath('goblin'), 'CUSTOM GOBLIN', 'utf8');
    expect(loadPersonaSpec('goblin')).toBe('CUSTOM GOBLIN');
    expect(isPersonaCustomized('goblin')).toBe(true);
  });

  it('loadPersonaSpec falls back to the default for an empty/whitespace override', () => {
    writeFileSync(personaSpecPath('operator'), '   \n', 'utf8');
    expect(loadPersonaSpec('operator')).toBe(PERSONA_SPECS.operator);
  });

  it('loadPersonaSpec falls back to the default for an oversize override', () => {
    writeFileSync(personaSpecPath('hype'), 'x'.repeat(40_000), 'utf8');
    expect(loadPersonaSpec('hype')).toBe(PERSONA_SPECS.hype);
  });

  it('seedPersonaSpec writes the default if absent, then is a no-op (never clobbers edits)', () => {
    const path = seedPersonaSpec('sensei');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').trim()).toBe(PERSONA_SPECS.sensei);

    writeFileSync(path, 'EDITED', 'utf8');
    seedPersonaSpec('sensei'); // must NOT overwrite an existing file
    expect(readFileSync(path, 'utf8')).toBe('EDITED');
  });

  it('resetPersonaSpec removes an override and reports whether one existed', () => {
    seedPersonaSpec('hype');
    expect(resetPersonaSpec('hype')).toBe(true);
    expect(isPersonaCustomized('hype')).toBe(false);
    expect(resetPersonaSpec('hype')).toBe(false);
  });
});
