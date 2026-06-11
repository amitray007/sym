/**
 * Editable per-persona spec overrides.
 *
 * The shipped default specs live in `@sym/kernel` (`PERSONA_SPECS`). A deployment
 * can override any of them by dropping a `<id>.md` file in the personas dir
 * (`SYM_PERSONAS_DIR`, default `<cwd>/.sym/personas`). The agent reads the
 * effective spec per turn, so an edit lands on the very next reply — no restart.
 *
 * Reads are FAIL-OPEN: a missing, empty, or unreadable override falls back to the
 * shipped default, so a bad file can never break a turn (it just doesn't apply).
 * The hard safety floor lives in the non-editable base prompt, so an override can
 * change a voice's flavour but never its guardrails.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PERSONA_SPECS, type PersonaName } from '@sym/kernel';

/** The personas override dir: `SYM_PERSONAS_DIR`, else `<cwd>/.sym/personas`. */
function personasDir(): string {
  return process.env['SYM_PERSONAS_DIR'] ?? join(process.cwd(), '.sym', 'personas');
}

/** Absolute path to a persona's override file (may not exist). */
export function personaSpecPath(persona: PersonaName): string {
  return join(personasDir(), `${persona}.md`);
}

/** Whether a persona currently has an override file on disk. */
export function isPersonaCustomized(persona: PersonaName): boolean {
  return existsSync(personaSpecPath(persona));
}

/**
 * The effective spec for a persona: the `<id>.md` override if present and
 * non-empty, else the shipped default. Fail-open — any read error → default.
 */
export function loadPersonaSpec(persona: PersonaName): string {
  try {
    const path = personaSpecPath(persona);
    // Oversize overrides (a mistake or abuse) fall back rather than bloating every
    // prompt; ~32 KB is ~10× the largest shipped spec. statSync first avoids
    // reading a pathological file into memory.
    if (statSync(path).size > 32_000) return PERSONA_SPECS[persona];
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length > 0 ? raw : PERSONA_SPECS[persona];
  } catch {
    return PERSONA_SPECS[persona];
  }
}

/**
 * Create the override file seeded with the current default spec if it doesn't
 * exist yet (so the owner edits a copy of the default, not a blank file).
 * Returns the path either way.
 */
export function seedPersonaSpec(persona: PersonaName): string {
  const path = personaSpecPath(persona);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${PERSONA_SPECS[persona]}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  return path;
}

/** Remove a persona's override (revert to the default); true if one existed. */
export function resetPersonaSpec(persona: PersonaName): boolean {
  const path = personaSpecPath(persona);
  const existed = existsSync(path);
  rmSync(path, { force: true }); // force → no throw if it vanished between check and rm
  return existed;
}
