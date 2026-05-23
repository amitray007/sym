import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('serialises null', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('serialises booleans', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it('serialises numbers', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-3.14)).toBe('-3.14');
    expect(canonicalJson(0)).toBe('0');
  });

  it('serialises strings', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson('with "quotes"')).toBe('"with \\"quotes\\""');
    expect(canonicalJson('')).toBe('""');
  });

  it('serialises arrays without whitespace', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson(['a', 'b'])).toBe('["a","b"]');
    expect(canonicalJson([])).toBe('[]');
  });

  it('sorts object keys lexicographically', () => {
    // Keys z, a, m → sorted: a, m, z
    const obj = { z: 1, a: 2, m: 3 };
    expect(canonicalJson(obj)).toBe('{"a":2,"m":3,"z":1}');
  });

  it('sorts keys recursively in nested objects', () => {
    const obj = {
      outer: { z: 1, a: 2 },
      alpha: { y: 'why', b: 'bee' },
    };
    expect(canonicalJson(obj)).toBe('{"alpha":{"b":"bee","y":"why"},"outer":{"a":2,"z":1}}');
  });

  it('is deterministic — same output for same input regardless of insertion order', () => {
    const a = { workspaceId: 'ws1', id: 1, kind: 'app.memory.write', actorKind: 'system' };
    const b = { kind: 'app.memory.write', id: 1, actorKind: 'system', workspaceId: 'ws1' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('produces no whitespace', () => {
    const result = canonicalJson({ a: 1, b: [2, 3], c: { d: 4 } });
    expect(result).not.toMatch(/\s/);
  });

  it('handles nested arrays of objects with sorted keys', () => {
    const result = canonicalJson([
      { z: 1, a: 2 },
      { y: 3, b: 4 },
    ]);
    expect(result).toBe('[{"a":2,"z":1},{"b":4,"y":3}]');
  });

  it('throws on Infinity', () => {
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
  });

  it('throws on NaN', () => {
    expect(() => canonicalJson(NaN)).toThrow(TypeError);
  });

  it('handles an object with all the audit event fields in arbitrary order', () => {
    // This mirrors the exact object buildHashInput produces (keys already sorted
    // here for readability — canonicalJson must still sort them).
    const eventFields = {
      workspaceId: 'ws_abc',
      ts: '2026-01-02T03:04:05.678Z',
      targetKind: null,
      targetId: null,
      onBehalfOf: null,
      kind: 'app.memory.write',
      id: 42,
      actorKind: 'system',
      actorId: 'system',
    };

    const result = canonicalJson(eventFields);

    // Key order must be: actorId, actorKind, id, kind, onBehalfOf, targetId, targetKind, ts, workspaceId
    expect(result).toBe(
      '{"actorId":"system","actorKind":"system","id":42,"kind":"app.memory.write",' +
        '"onBehalfOf":null,"targetId":null,"targetKind":null,' +
        '"ts":"2026-01-02T03:04:05.678Z","workspaceId":"ws_abc"}',
    );
  });
});
