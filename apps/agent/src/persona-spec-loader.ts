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
 * Warn at most once per (persona, reason): loadPersonaSpec runs on the per-turn
 * hot path, so a persistent misconfiguration must be visible in the server logs
 * without spamming a line every turn. Server logs use console.warn, never
 * console.log (see ARCHITECTURE I-7).
 */
const _warned = new Set<string>();
function warnOnce(key: string, message: string, err?: unknown): void {
  if (_warned.has(key)) return;
  _warned.add(key);
  if (err !== undefined) console.warn(message, err);
  else console.warn(message);
}

/**
 * The effective spec for a persona: the `<id>.md` override if present and
 * non-empty, else the shipped default. Fail-open — any read error → default.
 *
 * A MISSING override (ENOENT) is the normal case and stays silent. A present
 * but oversize or unreadable override is a real misconfiguration the operator
 * THINKS is applied but isn't — so it warns once before falling back, rather
 * than silently dropping the edit.
 */
export function loadPersonaSpec(persona: PersonaName): string {
  const path = personaSpecPath(persona);
  let size: number;
  try {
    // statSync first avoids reading a pathological file into memory.
    size = statSync(path).size;
  } catch (err) {
    // ENOENT = no override file, the normal case → silent default. Anything else
    // (e.g. EACCES on the personas dir) is a real misconfig → surface it once.
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      warnOnce(
        `stat:${persona}`,
        `[persona] could not read the ${persona} override at ${path}; using the shipped default:`,
        err,
      );
    }
    return PERSONA_SPECS[persona];
  }
  // Oversize overrides (a mistake or abuse) fall back rather than bloating every
  // prompt; ~32 KB is ~10× the largest shipped spec.
  if (size > 32_000) {
    warnOnce(
      `size:${persona}`,
      `[persona] the ${persona} override at ${path} is ${size} bytes (> 32 KB cap); ignoring it and using the shipped default.`,
    );
    return PERSONA_SPECS[persona];
  }
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length > 0 ? raw : PERSONA_SPECS[persona];
  } catch (err) {
    warnOnce(
      `read:${persona}`,
      `[persona] the ${persona} override at ${path} exists but could not be read; using the shipped default:`,
      err,
    );
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
