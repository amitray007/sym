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
});
