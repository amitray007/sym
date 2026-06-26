import { describe, expect, it } from 'vitest';

import { resolveRepo } from '../src/allowlist.js';

import type { RepoAllowlist } from '../src/types.js';

const allowlist: RepoAllowlist = [
  { name: 'sym', url: 'https://github.com/o/sym' },
  { name: 'WebApp', url: 'https://github.com/o/web' },
];

describe('resolveRepo', () => {
  it('resolves a known name', () => {
    expect(resolveRepo('sym', allowlist)).toEqual({ name: 'sym', url: 'https://github.com/o/sym' });
  });

  it('matches names case-insensitively', () => {
    expect(resolveRepo('webapp', allowlist)?.name).toBe('WebApp');
    expect(resolveRepo('WEBAPP', allowlist)?.name).toBe('WebApp');
  });

  it('resolves an exact url', () => {
    expect(resolveRepo('https://github.com/o/web', allowlist)?.name).toBe('WebApp');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveRepo('  sym  ', allowlist)?.name).toBe('sym');
  });

  it('returns null for an unknown repo', () => {
    expect(resolveRepo('secret', allowlist)).toBeNull();
  });

  it('does not match a url case-insensitively', () => {
    expect(resolveRepo('https://github.com/O/WEB', allowlist)).toBeNull();
  });

  it('returns null for an empty query or empty allowlist', () => {
    expect(resolveRepo('', allowlist)).toBeNull();
    expect(resolveRepo('sym', [])).toBeNull();
  });

  it('prefers a url match over an earlier entry whose name collides with that url', () => {
    const collision: RepoAllowlist = [
      { name: 'https://github.com/o/a', url: 'https://github.com/o/decoy' },
      { name: 'real', url: 'https://github.com/o/a' },
    ];
    // The query is a URL; it must resolve to the entry whose URL matches, not the
    // earlier entry that merely has a matching name.
    expect(resolveRepo('https://github.com/o/a', collision)?.url).toBe('https://github.com/o/a');
  });
});
