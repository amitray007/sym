import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';
import { buildHashInput, computeHash, type HashableEventFields } from './hash.js';

const baseFields: HashableEventFields = {
  id: 1,
  workspaceId: 'ws_abc123',
  kind: 'app.memory.write',
  actorKind: 'system',
  actorId: 'system',
  onBehalfOf: null,
  targetKind: null,
  targetId: null,
  ts: new Date('2026-01-02T03:04:05.678Z'),
  payload: { fact: 'prefers dark mode', subject: 'U123' },
};

describe('buildHashInput', () => {
  it('includes all required fields', () => {
    const obj = buildHashInput(baseFields);
    expect(obj).toMatchObject({
      id: 1,
      workspaceId: 'ws_abc123',
      kind: 'app.memory.write',
      actorKind: 'system',
      actorId: 'system',
      onBehalfOf: null,
      targetKind: null,
      targetId: null,
      ts: '2026-01-02T03:04:05.678Z',
    });
  });

  it('serialises ts as ISO-8601 UTC string', () => {
    const obj = buildHashInput(baseFields) as Record<string, unknown>;
    expect(typeof obj['ts']).toBe('string');
    expect(obj['ts']).toBe(baseFields.ts.toISOString());
  });

  it('maps undefined optional fields to null', () => {
    const fields: HashableEventFields = {
      ...baseFields,
      onBehalfOf: null,
      targetKind: null,
      targetId: null,
    };
    const obj = buildHashInput(fields) as Record<string, unknown>;
    expect(obj['onBehalfOf']).toBeNull();
    expect(obj['targetKind']).toBeNull();
    expect(obj['targetId']).toBeNull();
  });
});

describe('computeHash', () => {
  it('produces a 32-byte Buffer', () => {
    const h = computeHash(null, baseFields);
    expect(h).toBeInstanceOf(Buffer);
    expect(h.length).toBe(32);
  });

  it('is deterministic — same inputs → same hash', () => {
    const h1 = computeHash(null, baseFields);
    const h2 = computeHash(null, baseFields);
    expect(h1.equals(h2)).toBe(true);
  });

  it('chain link — hash changes when prevHash changes', () => {
    const h1 = computeHash(null, baseFields);
    const h2 = computeHash(Buffer.alloc(32, 0xab), baseFields);
    expect(h1.equals(h2)).toBe(false);
  });

  it('chain link — hash changes when any field changes', () => {
    const h1 = computeHash(null, baseFields);
    const h2 = computeHash(null, { ...baseFields, kind: 'gen_ai.completion' });
    expect(h1.equals(h2)).toBe(false);
  });

  it('links correctly: thisHash(n) feeds as prevHash(n+1)', () => {
    const h0 = computeHash(null, baseFields);
    const fields2: HashableEventFields = { ...baseFields, id: 2 };
    const h1 = computeHash(h0, fields2);

    // Verify manually: SHA-256( h0 ‖ utf8(canonicalJson(fields2)) )
    const jsonBytes = Buffer.from(
      canonicalJson(buildHashInput(fields2) as Parameters<typeof canonicalJson>[0]),
      'utf8',
    );
    const expected = createHash('sha256').update(h0).update(jsonBytes).digest();
    expect(h1.equals(expected)).toBe(true);
  });

  it('tamper detection — changing a field produces a different hash', () => {
    const h1 = computeHash(null, baseFields);
    // Tamper: change actorId
    const tampered = { ...baseFields, actorId: 'attacker' };
    const h2 = computeHash(null, tampered);
    expect(h1.equals(h2)).toBe(false);
  });

  it('tamper detection — changing id produces a different hash', () => {
    const h1 = computeHash(null, baseFields);
    const h2 = computeHash(null, { ...baseFields, id: 2 });
    expect(h1.equals(h2)).toBe(false);
  });

  it('tamper detection — changing the payload produces a different hash', () => {
    const h1 = computeHash(null, baseFields);
    const h2 = computeHash(null, {
      ...baseFields,
      payload: { fact: 'prefers LIGHT mode', subject: 'U123' },
    });
    expect(h1.equals(h2)).toBe(false);
  });

  it('first event (prevHash=null) has no prevHash prefix', () => {
    // Recompute manually with no prevHash
    const hashInput = buildHashInput(baseFields) as Parameters<typeof canonicalJson>[0];
    const jsonBytes = Buffer.from(canonicalJson(hashInput), 'utf8');
    const expected = createHash('sha256').update(jsonBytes).digest();
    const actual = computeHash(null, baseFields);
    expect(actual.equals(expected)).toBe(true);
  });

  it('second event (prevHash non-null) prefixes the prevHash bytes', () => {
    const prev = Buffer.alloc(32, 0xff);
    const hashInput = buildHashInput(baseFields) as Parameters<typeof canonicalJson>[0];
    const jsonBytes = Buffer.from(canonicalJson(hashInput), 'utf8');
    const expected = createHash('sha256').update(prev).update(jsonBytes).digest();
    const actual = computeHash(prev, baseFields);
    expect(actual.equals(expected)).toBe(true);
  });
});
