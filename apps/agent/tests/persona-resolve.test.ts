/**
 * effectiveHomePersona — channel override beats global home, with fail-safe
 * fallbacks. The lookup is injected so these tests never touch SQLite.
 */

import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { _resetChannelPersonaStoreForTesting } from '@sym/mcp-runtime';

import { effectiveHomePersona } from '../src/persona-resolve.js';

describe('effectiveHomePersona', () => {
  it('uses a valid per-channel override over the global home', () => {
    expect(effectiveHomePersona('C_eng', 'sym', () => 'goblin')).toBe('goblin');
  });

  it('falls back to the global home when there is no override', () => {
    expect(effectiveHomePersona('C_eng', 'concierge', () => undefined)).toBe('concierge');
  });

  it('falls back to the global home when the stored value is not a valid voice', () => {
    expect(effectiveHomePersona('C_eng', 'sym', () => 'wizard')).toBe('sym');
  });

  it('returns the global home when there is no channel', () => {
    expect(effectiveHomePersona(undefined, 'hype', () => 'goblin')).toBe('hype');
  });

  it('returns undefined when neither a channel override nor a global home exists', () => {
    expect(effectiveHomePersona('C_eng', undefined, () => undefined)).toBeUndefined();
  });

  it('fails open to the global home when the real settings store cannot be opened', () => {
    // No injected lookup → exercises the real readChannelPersona + its try/catch.
    // Point the store at a directory so opening it as a SQLite file throws.
    const saved = process.env['SYM_SETTINGS_DB_PATH'];
    process.env['SYM_SETTINGS_DB_PATH'] = tmpdir();
    _resetChannelPersonaStoreForTesting();
    try {
      expect(effectiveHomePersona('C_eng', 'sym')).toBe('sym');
    } finally {
      _resetChannelPersonaStoreForTesting();
      if (saved === undefined) delete process.env['SYM_SETTINGS_DB_PATH'];
      else process.env['SYM_SETTINGS_DB_PATH'] = saved;
    }
  });
});
