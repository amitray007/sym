import { describe, expect, it, beforeEach } from 'vitest';

import { _resetStarterPromptsForTests, loadStarterPrompts } from '../src/manifest-prompts.js';

describe('loadStarterPrompts', () => {
  beforeEach(() => {
    _resetStarterPromptsForTests();
  });

  it('reads the real manifest at slack/manifest.template.yml and returns the configured prompts', () => {
    const prompts = loadStarterPrompts();
    // Sanity: every entry is a well-formed { title, message } pair.
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(typeof p.title).toBe('string');
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.message).toBe('string');
      expect(p.message.length).toBeGreaterThan(0);
    }
  });

  it('memoises the result across calls (single parse per process)', () => {
    const a = loadStarterPrompts();
    const b = loadStarterPrompts();
    // Same reference — proves the cache short-circuited.
    expect(a).toBe(b);
  });
});
