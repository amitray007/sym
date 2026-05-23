/**
 * Deterministic canonical-JSON serialisation for audit hash chain computation.
 *
 * VERIFIER SPEC — every field, every rule:
 *
 * 1. Only JSON-safe value types are permitted: `string`, `number`, `boolean`,
 *    `null`, plain objects, and arrays.  `undefined` is forbidden.
 *
 * 2. Object keys are sorted lexicographically (byte-order, same as
 *    `Array.prototype.sort()` with no comparator) at every nesting depth.
 *
 * 3. No whitespace: no spaces, no line-feeds, no indentation.
 *
 * 4. Strings are serialised with `JSON.stringify`'s default escaping rules
 *    (i.e. control characters escaped, Unicode pass-through).
 *
 * 5. Numbers follow `JSON.stringify` semantics.  Infinity and NaN are
 *    disallowed (they cannot appear in the hashed event columns anyway, but
 *    we error loudly rather than silently emit "null").
 *
 * The output is a UTF-8 string (not a Buffer); callers must encode it with
 * `Buffer.from(str, 'utf8')` before concatenating with prevHash.
 */

import type { JsonValue } from '@sym/contracts';

/**
 * Serialise a JSON value to canonical JSON.
 *
 * Rules (documented at top of file):
 * - Object keys sorted lexicographically, recursively.
 * - No whitespace.
 * - `undefined` / `Infinity` / `NaN` throw.
 */
export function canonicalJson(value: JsonValue): string {
  return serialise(value);
}

function serialise(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canonicalJson: non-finite number (${String(value)}) cannot be serialised to JSON`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => serialise(v as JsonValue));
    return `[${items.join(',')}]`;
  }
  // Plain object
  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => {
    const v = (value as Record<string, JsonValue>)[k];
    if (v === undefined) {
      throw new TypeError(`canonicalJson: key "${k}" has value undefined — not JSON-safe`);
    }
    return `${JSON.stringify(k)}:${serialise(v)}`;
  });
  return `{${pairs.join(',')}}`;
}
