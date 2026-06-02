/**
 * Unit tests for tools/_helpers.ts.
 *
 * Covers:
 *   - argError, execError, errMsg, clampedLimit  (error/coercion helpers)
 *   - fieldsFor across its three channel branches: DM, channel, fallback
 *   - dedupeSearchMatches (search dedup)
 *   - coerceCardFields / coerceCardActions (coercion helpers)
 *
 * Uses a minimal fake NameResolver to control cache state without real I/O.
 */

import { describe, expect, it } from 'vitest';

import { NameResolver } from '../src/name-resolver.js';
import {
  argError,
  clampedLimit,
  coerceCardActions,
  coerceCardFields,
  dedupeSearchMatches,
  errMsg,
  execError,
  fieldsFor,
} from '../src/tools/_helpers.js';

import type { DedupedSearchMatch } from '../src/tools/_helpers.js';
import type { SearchMessageMatch } from '@sym/adapter-slack';
import type { SlackChannelId, ToolCall } from '@sym/contracts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCall(name = 'tool', id = 'c01'): ToolCall {
  return { id, name, arguments: {} };
}

/**
 * Build a minimal SearchMessageMatch for testing. Fields are intentionally
 * loose here — cast to the branded types to avoid having to import the brand
 * factories in every test. Only `channelId` is required by the interface; we
 * provide a placeholder and let overrides replace it.
 */
function makeMatch(overrides: Record<string, unknown> = {}): SearchMessageMatch {
  return {
    text: 'hello world',
    ts: '0.0' as SearchMessageMatch['ts'],
    channelId: 'C_DEFAULT' as SlackChannelId,
    ...overrides,
  } as SearchMessageMatch;
}

function makeDedupedMatch(overrides: Record<string, unknown> = {}, count = 1): DedupedSearchMatch {
  return { match: makeMatch(overrides), count };
}

// ---------------------------------------------------------------------------
// argError / execError / errMsg
// ---------------------------------------------------------------------------

describe('argError', () => {
  it('returns a ToolResult with ok:false and code:invalid_arguments', () => {
    const call = makeCall('my_tool', 'call_99');
    const result = argError(call, 'bad arg');
    expect(result).toEqual({
      callId: 'call_99',
      ok: false,
      error: { code: 'invalid_arguments', message: 'bad arg' },
    });
  });

  it('preserves the call id', () => {
    const result = argError(makeCall('t', 'xyz'), 'err');
    expect(result.callId).toBe('xyz');
  });
});

describe('execError', () => {
  it('returns a ToolResult with ok:false and code:execution_failed', () => {
    const call = makeCall('my_tool', 'call_42');
    const result = execError(call, 'network error');
    expect(result).toEqual({
      callId: 'call_42',
      ok: false,
      error: { code: 'execution_failed', message: 'network error' },
    });
  });
});

describe('errMsg', () => {
  it('extracts .message from an Error', () => {
    expect(errMsg(new Error('oops'))).toBe('oops');
  });

  it('stringifies a non-Error thrown value', () => {
    expect(errMsg('raw string')).toBe('raw string');
    expect(errMsg(42)).toBe('42');
    expect(errMsg(null)).toBe('null');
  });
});

// ---------------------------------------------------------------------------
// clampedLimit
// ---------------------------------------------------------------------------

describe('clampedLimit', () => {
  it('returns the default when arg is not a number', () => {
    expect(clampedLimit(undefined, 30, 1, 100)).toBe(30);
    expect(clampedLimit('bad', 30, 1, 100)).toBe(30);
    expect(clampedLimit(null, 30, 1, 100)).toBe(30);
  });

  it('clamps below the minimum', () => {
    expect(clampedLimit(0, 30, 1, 100)).toBe(1);
    expect(clampedLimit(-5, 30, 1, 100)).toBe(1);
  });

  it('clamps above the maximum', () => {
    expect(clampedLimit(999, 30, 1, 100)).toBe(100);
  });

  it('returns the value unchanged when in range', () => {
    expect(clampedLimit(50, 30, 1, 100)).toBe(50);
    expect(clampedLimit(1, 30, 1, 100)).toBe(1);
    expect(clampedLimit(100, 30, 1, 100)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// fieldsFor — three branch coverage
// ---------------------------------------------------------------------------

describe('fieldsFor', () => {
  /**
   * Branch 1: DM channel (channelId starts with 'D').
   * The DM participant should be resolved from the cache, producing
   * `a DM with <@U…>` / `DM with <name>` labels.
   */
  it('DM branch — formats whereTag/whereCell from cached DM participant', () => {
    const resolver = new NameResolver();
    // Seed the cache: D001 → user U_bob, name "Bob"
    resolver['dms'].set('D001', 'U_bob');
    resolver['users'].set('U_bob', 'Bob');

    const d = makeDedupedMatch({ userId: 'U_alice', channelId: 'D001' });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('a DM with <@U_bob>');
    expect(result.whereCell).toBe('DM with Bob');
    // Author
    expect(result.whoTag).toBe('<@U_alice>');
  });

  it('DM branch — falls back gracefully when DM participant is unknown', () => {
    const resolver = new NameResolver();
    // D999 is not seeded

    const d = makeDedupedMatch({ channelId: 'D999' });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('a DM');
    expect(result.whereCell).toBe('Direct message');
  });

  it('DM branch — includes userId without name when only userId is cached', () => {
    const resolver = new NameResolver();
    resolver['dms'].set('D002', 'U_carol');
    // User name NOT seeded — only the DM→userId mapping

    const d = makeDedupedMatch({ channelId: 'D002' });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('a DM with <@U_carol>');
    // name is undefined, so falls back to 'Direct message'
    expect(result.whereCell).toBe('Direct message');
  });

  /**
   * Branch 2: Regular Slack channel (channelId starts with 'C').
   * Should produce `<#C…>` tag and `#name` cell.
   */
  it('channel branch — formats whereTag/whereCell from cached channel name', () => {
    const resolver = new NameResolver();
    resolver['channels'].set('C001', 'general');

    const d = makeDedupedMatch({ channelId: 'C001' });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('<#C001>');
    expect(result.whereCell).toBe('#general');
  });

  it('channel branch — falls back to "#channel" when name is not cached', () => {
    const resolver = new NameResolver();
    // C999 not seeded

    const d = makeDedupedMatch({ channelId: 'C999' });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('<#C999>');
    expect(result.whereCell).toBe('#channel');
  });

  it('channel branch — prefers match.channelName over resolver cache', () => {
    const resolver = new NameResolver();
    resolver['channels'].set('C001', 'old-name');

    const d = makeDedupedMatch({ channelId: 'C001', channelName: 'new-name' });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('<#C001>');
    expect(result.whereCell).toBe('#new-name');
  });

  /**
   * Branch 3: Fallback — no channelId or unrecognized id format.
   */
  it('fallback branch — returns "a conversation" when channelId is missing', () => {
    const resolver = new NameResolver();
    // No channelId at all
    const d = makeDedupedMatch({ channelId: undefined });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('a conversation');
    expect(result.whereCell).toBe('a conversation');
  });

  it('fallback branch — uses channelName from match when channelId is not C… or D…', () => {
    const resolver = new NameResolver();
    // Some unusual id format that doesn't match C… or D…
    const d = makeDedupedMatch({ channelId: 'G001groups', channelName: 'a-group' });
    const result = fieldsFor(d, resolver);

    expect(result.whereTag).toBe('#a-group');
    expect(result.whereCell).toBe('#a-group');
  });

  // Author fields
  it('uses username as fallback when userId is absent', () => {
    const resolver = new NameResolver();
    const d = makeDedupedMatch({ userId: undefined, username: 'alice' });
    const result = fieldsFor(d, resolver);

    expect(result.whoTag).toBe('alice');
    expect(result.whoCell).toBe('alice');
  });

  it('uses "(unknown)" when both userId and username are absent', () => {
    const resolver = new NameResolver();
    const d = makeDedupedMatch({ userId: undefined, username: undefined });
    const result = fieldsFor(d, resolver);

    expect(result.whoTag).toBe('(unknown)');
    expect(result.whoCell).toBe('(unknown)');
  });

  // Repeat / permalink
  it('formats rep as "(sent N×)" when count > 1', () => {
    const resolver = new NameResolver();
    const d: DedupedSearchMatch = { match: makeMatch(), count: 3 };
    const result = fieldsFor(d, resolver);

    expect(result.rep).toBe(' (sent 3×)');
  });

  it('rep is empty string when count is 1', () => {
    const resolver = new NameResolver();
    const d = makeDedupedMatch();
    const result = fieldsFor(d, resolver);

    expect(result.rep).toBe('');
  });

  it('returns the permalink from the match', () => {
    const resolver = new NameResolver();
    const d = makeDedupedMatch({ permalink: 'https://slack.com/p123' });
    const result = fieldsFor(d, resolver);

    expect(result.permalink).toBe('https://slack.com/p123');
  });
});

// ---------------------------------------------------------------------------
// dedupeSearchMatches
// ---------------------------------------------------------------------------

describe('dedupeSearchMatches', () => {
  it('returns an empty array for empty input', () => {
    expect(dedupeSearchMatches([])).toEqual([]);
  });

  it('returns single-entry results unchanged (count=1)', () => {
    const m = makeMatch({ text: 'hello' });
    const result = dedupeSearchMatches([m]);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(1);
  });

  it('collapses identical text+user duplicates, preserving first occurrence', () => {
    const a = makeMatch({ text: 'hello world', userId: 'U1' });
    const b = makeMatch({ text: 'hello world', userId: 'U1' }); // duplicate
    const c = makeMatch({ text: 'different', userId: 'U1' });

    const result = dedupeSearchMatches([a, b, c]);
    expect(result).toHaveLength(2);
    expect(result[0]?.count).toBe(2); // a+b collapsed
    expect(result[1]?.count).toBe(1); // c unique
  });

  it('does not collapse messages with same text but different users', () => {
    const a = makeMatch({ text: 'hello', userId: 'U1' });
    const b = makeMatch({ text: 'hello', userId: 'U2' });

    const result = dedupeSearchMatches([a, b]);
    expect(result).toHaveLength(2);
  });

  it('normalizes whitespace before comparing', () => {
    const a = makeMatch({ text: 'hello   world', userId: 'U1' });
    const b = makeMatch({ text: 'hello world', userId: 'U1' }); // same after normalization

    const result = dedupeSearchMatches([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// coerceCardFields
// ---------------------------------------------------------------------------

describe('coerceCardFields', () => {
  it('returns [] for non-array input', () => {
    expect(coerceCardFields(null)).toEqual([]);
    expect(coerceCardFields('string')).toEqual([]);
    expect(coerceCardFields(42)).toEqual([]);
  });

  it('drops entries missing label or value', () => {
    const result = coerceCardFields([
      { label: 'Foo' },
      { value: 'Bar' },
      { label: 'L', value: 'V' },
    ]);
    expect(result).toEqual([{ label: 'L', value: 'V' }]);
  });

  it('drops entries where label or value are non-strings', () => {
    const result = coerceCardFields([
      { label: 42, value: 'v' },
      { label: 'l', value: true },
    ]);
    expect(result).toEqual([]);
  });

  it('returns valid entries in order', () => {
    const result = coerceCardFields([
      { label: 'Status', value: 'Open' },
      { label: 'Owner', value: 'Alice' },
    ]);
    expect(result).toEqual([
      { label: 'Status', value: 'Open' },
      { label: 'Owner', value: 'Alice' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// coerceCardActions
// ---------------------------------------------------------------------------

describe('coerceCardActions', () => {
  it('returns [] for non-array input', () => {
    expect(coerceCardActions(null)).toEqual([]);
    expect(coerceCardActions(undefined)).toEqual([]);
  });

  it('drops entries with non-https URLs', () => {
    const result = coerceCardActions([
      { label: 'View', url: 'ftp://bad.com' },
      { label: 'Open', url: 'https://good.com' },
    ]);
    expect(result).toEqual([{ label: 'Open', url: 'https://good.com' }]);
  });

  it('accepts http:// URLs as well', () => {
    const result = coerceCardActions([{ label: 'X', url: 'http://example.com' }]);
    expect(result).toEqual([{ label: 'X', url: 'http://example.com' }]);
  });

  it('drops entries missing label or url', () => {
    const result = coerceCardActions([{ label: 'X' }, { url: 'https://x.com' }]);
    expect(result).toEqual([]);
  });
});
