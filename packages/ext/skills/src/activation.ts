/**
 * Skill activation — lightweight pattern match.
 *
 * Given an incoming message text and a list of loaded Skills, returns the
 * skills whose `activationPattern` matches the message.
 *
 * Pattern semantics:
 *  - If `activationPattern` is a regex literal (`/…/flags`) it is compiled
 *    and tested against the message.
 *  - Otherwise it is a case-insensitive substring match.
 *
 * Usage:
 *   const active = matchSkills(message, allSkills);
 *   // active.forEach(skill => injectIntoContext(skill));
 */

import type { Skill } from './types.js';

/**
 * Match skills against an incoming message.
 *
 * Returns the subset of `skills` whose `activationPattern` matches `message`.
 * Skills without an `activationPattern` are never returned from this function
 * (they may be activated by other means, e.g. explicit `/skill` invocation).
 */
export function matchSkills(message: string, skills: Skill[]): Skill[] {
  return skills.filter((skill) => {
    if (!skill.activationPattern) return false;
    return testPattern(skill.activationPattern, message);
  });
}

/**
 * Build the context snippet to inject for an activated skill.
 *
 * Returns a string block that can be prepended to the system prompt / next
 * turn context.  The block is delimited so the model can identify it.
 */
export function buildSkillContext(skill: Skill): string {
  return [
    `<active-skill slug="${skill.slug}" name="${escapeAttr(skill.name)}">`,
    skill.bodyMd.trim(),
    '</active-skill>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cached compiled regex patterns. */
const compiledPatterns = new Map<string, RegExp | null>();

/**
 * Parse a pattern string into a RegExp, or null if it is a plain substring.
 * Regex literals have the form `/pattern/flags`.
 */
function parsePattern(pattern: string): RegExp | null {
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  if (!regexMatch) return null;

  const body = regexMatch[1];
  const flags = regexMatch[2] ?? '';

  if (!body) return null;

  try {
    return new RegExp(body, flags);
  } catch {
    // Malformed regex — fall back to substring match.
    return null;
  }
}

function testPattern(pattern: string, message: string): boolean {
  // Cache compiled patterns to avoid re-parsing on every message.
  if (!compiledPatterns.has(pattern)) {
    compiledPatterns.set(pattern, parsePattern(pattern));
  }

  const regex = compiledPatterns.get(pattern);
  if (regex !== undefined && regex !== null) {
    return regex.test(message);
  }

  // Plain case-insensitive substring match.
  return message.toLowerCase().includes(pattern.toLowerCase());
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
