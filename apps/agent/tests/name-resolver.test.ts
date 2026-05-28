/**
 * Unit tests for the workspace-scoped NameResolver.
 *
 * Covers: cached/sync accessors, lazy user resolution via users.info,
 * eager channel fill via conversations.list, mention rewriting with mixed
 * known/unknown ids, sticky failure caching, and bulk-fill coalescing.
 */

import { describe, expect, it, vi } from 'vitest';

import { NameResolver } from '../src/name-resolver.js';

import type { SlackClient } from '@sym/adapter-slack';

/** Tiny SlackClient stub — fills in only the methods the resolver touches. */
function makeClient(overrides: Partial<SlackClient> = {}): SlackClient {
  return {
    usersInfo: vi.fn(),
    conversationsList: vi.fn(),
    ...overrides,
  } as unknown as SlackClient;
}

describe('NameResolver.resolveUser', () => {
  it('hits users.info on first call and caches the result', async () => {
    const usersInfo = vi
      .fn()
      .mockResolvedValue({ displayName: 'Amit', realName: 'Amit Ray', userName: 'amit' });
    const client = makeClient({ usersInfo });
    const r = new NameResolver();

    const name = await r.resolveUser('U042', client);
    expect(name).toBe('Amit');
    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(r.getUser('U042')).toBe('Amit');

    // Second call — no API hit.
    const cached = await r.resolveUser('U042', client);
    expect(cached).toBe('Amit');
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  it('falls back through displayName → realName → userName', async () => {
    const usersInfo = vi.fn().mockResolvedValue({
      displayName: undefined,
      realName: undefined,
      userName: 'amit',
    });
    const r = new NameResolver();
    expect(await r.resolveUser('U042', makeClient({ usersInfo }))).toBe('amit');
  });

  it('caches failures as null and returns the raw id', async () => {
    const usersInfo = vi.fn().mockRejectedValue(new Error('user_not_found'));
    const r = new NameResolver();

    const name = await r.resolveUser('UDEAD', makeClient({ usersInfo }));
    expect(name).toBe('UDEAD');
    // Sticky: second call doesn't re-hit the API.
    await r.resolveUser('UDEAD', makeClient({ usersInfo }));
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  it('returns the raw id when users.info reports no usable name fields', async () => {
    const usersInfo = vi
      .fn()
      .mockResolvedValue({ displayName: undefined, realName: undefined, userName: undefined });
    const r = new NameResolver();
    expect(await r.resolveUser('U042', makeClient({ usersInfo }))).toBe('U042');
  });
});

describe('NameResolver.resolveChannel', () => {
  it('triggers a single bulk fill on first miss', async () => {
    const conversationsList = vi.fn().mockResolvedValue({
      channels: [
        { id: 'C100', name: 'general', isPrivate: false },
        { id: 'C101', name: 'eng', isPrivate: false },
      ],
    });
    const client = makeClient({ conversationsList });
    const r = new NameResolver();

    const a = await r.resolveChannel('C100', client);
    const b = await r.resolveChannel('C101', client);
    expect(a).toBe('general');
    expect(b).toBe('eng');
    expect(conversationsList).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw id when bulk fill misses the channel', async () => {
    const conversationsList = vi
      .fn()
      .mockResolvedValue({ channels: [{ id: 'C100', name: 'general', isPrivate: false }] });
    const r = new NameResolver();
    expect(await r.resolveChannel('CGHOST', makeClient({ conversationsList }))).toBe('CGHOST');
    // Subsequent calls return cached null → still raw, no re-fetch.
    await r.resolveChannel('CGHOST', makeClient({ conversationsList }));
    expect(conversationsList).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent bulk fills into one API call', async () => {
    let resolveFn!: (v: { channels: { id: string; name: string; isPrivate: boolean }[] }) => void;
    const inflight = new Promise<{ channels: { id: string; name: string; isPrivate: boolean }[] }>(
      (resolve) => {
        resolveFn = resolve;
      },
    );
    const conversationsList = vi.fn().mockReturnValue(inflight);
    const client = makeClient({ conversationsList });
    const r = new NameResolver();

    const p1 = r.resolveChannel('C100', client);
    const p2 = r.resolveChannel('C101', client);
    resolveFn({
      channels: [
        { id: 'C100', name: 'general', isPrivate: false },
        { id: 'C101', name: 'eng', isPrivate: false },
      ],
    });
    expect(await p1).toBe('general');
    expect(await p2).toBe('eng');
    expect(conversationsList).toHaveBeenCalledTimes(1);
  });
});

describe('NameResolver.rewriteMentions', () => {
  it('rewrites user mentions to @DisplayName', async () => {
    const r = new NameResolver();
    r.primeForTests({ U042: 'Amit', U999: 'Sarah' }, {});
    const out = await r.rewriteMentions(
      'hey <@U042> can you ping <@U999> about the deploy?',
      makeClient(),
    );
    expect(out).toBe('hey @Amit can you ping @Sarah about the deploy?');
  });

  it('rewrites channel links to #name, preferring cached name over inline label', async () => {
    const r = new NameResolver();
    r.primeForTests({}, { C100: 'general', C101: 'eng' });
    const out = await r.rewriteMentions('see <#C100|outdated-label> and <#C101>', makeClient());
    expect(out).toBe('see #general and #eng');
  });

  it('uses inline channel label as fallback when no cache entry exists', async () => {
    const conversationsList = vi.fn().mockResolvedValue({ channels: [] });
    const r = new NameResolver();
    const out = await r.rewriteMentions(
      'see <#CGHOST|frozen-name>',
      makeClient({ conversationsList }),
    );
    expect(out).toBe('see #frozen-name');
  });

  it('leaves unresolvable mentions intact rather than dropping them', async () => {
    const usersInfo = vi.fn().mockRejectedValue(new Error('not_found'));
    const conversationsList = vi.fn().mockResolvedValue({ channels: [] });
    const r = new NameResolver();
    const out = await r.rewriteMentions(
      'unknown <@UDEAD> and <#CGHOST>',
      makeClient({ usersInfo, conversationsList }),
    );
    expect(out).toBe('unknown <@UDEAD> and <#CGHOST>');
  });

  it('resolves unknown user ids lazily during a rewrite', async () => {
    const usersInfo = vi.fn().mockResolvedValue({
      displayName: 'Sarah',
      realName: 'Sarah K',
      userName: 'sarah',
    });
    const r = new NameResolver();
    const out = await r.rewriteMentions('ping <@U999>', makeClient({ usersInfo }));
    expect(out).toBe('ping @Sarah');
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  it('handles a mix of known and unknown ids in one pass', async () => {
    const usersInfo = vi.fn().mockResolvedValue({
      displayName: 'Sarah',
      realName: 'Sarah K',
      userName: 'sarah',
    });
    const r = new NameResolver();
    r.primeForTests({ U042: 'Amit' }, { C100: 'general' });
    const out = await r.rewriteMentions(
      '<@U042> in <#C100> told <@U999> to look',
      makeClient({ usersInfo }),
    );
    expect(out).toBe('@Amit in #general told @Sarah to look');
    expect(usersInfo).toHaveBeenCalledTimes(1); // only U999, not U042
  });

  it('is a no-op on empty input', async () => {
    const r = new NameResolver();
    expect(await r.rewriteMentions('', makeClient())).toBe('');
  });
});

describe('NameResolver.rewriteMentionsCached', () => {
  it('rewrites only what is already cached, leaving misses raw', () => {
    const r = new NameResolver();
    r.primeForTests({ U042: 'Amit' }, { C100: 'general' });
    expect(r.rewriteMentionsCached('<@U042> in <#C100> mentioned <@U999>')).toBe(
      '@Amit in #general mentioned <@U999>',
    );
  });
});

describe('NameResolver.populateChannels', () => {
  it('warms the cache; subsequent resolves are sync', async () => {
    const conversationsList = vi.fn().mockResolvedValue({
      channels: [
        { id: 'C100', name: 'general', isPrivate: false },
        { id: 'C101', name: 'eng', isPrivate: false },
      ],
    });
    const r = new NameResolver();
    await r.populateChannels(makeClient({ conversationsList }));
    expect(r.getChannel('C100')).toBe('general');
    expect(r.getChannel('C101')).toBe('eng');
  });

  it('swallows API failure and continues in lazy mode', async () => {
    const conversationsList = vi.fn().mockRejectedValue(new Error('rate_limited'));
    const r = new NameResolver();
    await expect(r.populateChannels(makeClient({ conversationsList }))).resolves.not.toThrow();
    expect(r.getChannel('C100')).toBeUndefined();
  });
});
