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
    usersList: vi.fn(),
    conversationsList: vi.fn(),
    conversationsInfo: vi.fn(),
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

  it('caches a definitive user_not_found as null and returns the raw id', async () => {
    const usersInfo = vi.fn().mockRejectedValue(new Error('user_not_found'));
    const r = new NameResolver();

    const name = await r.resolveUser('UDEAD', makeClient({ usersInfo }));
    expect(name).toBe('UDEAD');
    // Sticky: second call doesn't re-hit the API.
    await r.resolveUser('UDEAD', makeClient({ usersInfo }));
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a transient failure (rate_limited) — retries next time (audit #5)', async () => {
    const usersInfo = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('rate_limited'), { code: 'rate_limited' }));
    const r = new NameResolver();
    const client = makeClient({ usersInfo });

    expect(await r.resolveUser('U042', client)).toBe('U042'); // raw id, uncached
    expect(await r.resolveUser('U042', client)).toBe('U042');
    // Re-hit the API on the second call — the miss was NOT made sticky.
    expect(usersInfo).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent resolves of the same id into one API call (audit #11)', async () => {
    let resolveFn!: (v: { displayName: string }) => void;
    const inflight = new Promise<{ displayName: string }>((res) => {
      resolveFn = res;
    });
    const usersInfo = vi.fn().mockReturnValue(inflight);
    const r = new NameResolver();
    const client = makeClient({ usersInfo });

    const p1 = r.resolveUser('U042', client);
    const p2 = r.resolveUser('U042', client);
    resolveFn({ displayName: 'Amit' });
    expect(await p1).toBe('Amit');
    expect(await p2).toBe('Amit');
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
  it('preserves canonical user mention tokens so Slack renders clickable @mentions', async () => {
    const r = new NameResolver();
    r.primeForTests({ U042: 'Amit', U999: 'Sarah' }, {});
    const out = await r.rewriteMentions(
      'hey <@U042> can you ping <@U999> about the deploy?',
      makeClient(),
    );
    // Tokens pass through untouched — Slack's markdown_text renders them as the
    // live, clickable names (and notifies, which is intended).
    expect(out).toBe('hey <@U042> can you ping <@U999> about the deploy?');
  });

  it('keeps canonical channel tokens and drops stale inline labels', async () => {
    const r = new NameResolver();
    r.primeForTests({}, { C100: 'general', C101: 'eng' });
    const out = await r.rewriteMentions('see <#C100|outdated-label> and <#C101>', makeClient());
    // `<#C…>` renders the LIVE channel name in Slack — keep the token, drop the
    // possibly-stale inline label.
    expect(out).toBe('see <#C100> and <#C101>');
  });

  it('keeps the canonical channel token even when the name is not cached', async () => {
    const conversationsList = vi.fn().mockResolvedValue({ channels: [] });
    const r = new NameResolver();
    const out = await r.rewriteMentions(
      'see <#CGHOST|frozen-name>',
      makeClient({ conversationsList }),
    );
    expect(out).toBe('see <#CGHOST>');
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

  it('rewrites DM-style channel markup (`<#U…|…>`) to a `<@U…>` mention token', async () => {
    // Slack search results sometimes carry DMs as channel-link syntax with a
    // USER id prefix. The id is a user id — emit it as a `<@U…>` mention token
    // (Slack renders the person's name even if WE never resolved it). NEVER a
    // raw `#U…` id.
    const conversationsList = vi.fn();
    const r = new NameResolver();
    const out = await r.rewriteMentions(
      'See <#U03U3R8232T|direct message>',
      makeClient({ conversationsList }),
    );
    expect(out).toBe('See <@U03U3R8232T>');
    // U-prefix ids must NOT trigger a channel bulk-fill API call.
    expect(conversationsList).not.toHaveBeenCalled();
  });

  it('emits a `<@U…>` token for bare DM-style markup with no inline label', async () => {
    // `<#U03…>` with no `|label` had NO fallback before — the raw id leaked.
    // Now it becomes a clickable mention token Slack resolves at render time.
    const r = new NameResolver();
    const out = await r.rewriteMentions('opened in <#U03U3R8232T>', makeClient());
    expect(out).toBe('opened in <@U03U3R8232T>');
  });

  it('resolves a `<#D…>` DM channel link to its counterpart `<@U…>` token', async () => {
    const conversationsInfo = vi.fn().mockResolvedValue({
      id: 'D04ABC',
      isIm: true,
      isMpim: false,
      userId: 'U777',
    });
    const r = new NameResolver();
    const out = await r.rewriteMentions(
      'posted via <#D04ABC|dm with sarah>',
      makeClient({ conversationsInfo }),
    );
    expect(out).toBe('posted via <@U777>');
    expect(conversationsInfo).toHaveBeenCalledTimes(1);
  });

  it('falls back to the inline label for an unresolvable `<#D…>` DM link', async () => {
    const conversationsInfo = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    const r = new NameResolver();
    const out = await r.rewriteMentions(
      'posted via <#D04ABC|dm with sarah>',
      makeClient({ conversationsInfo }),
    );
    expect(out).toBe('posted via dm with sarah');
    expect(out).not.toContain('D04ABC'); // raw DM id must never leak
  });

  it('still resolves unknown user ids (warms the cache) while preserving the token', async () => {
    const usersInfo = vi.fn().mockResolvedValue({
      displayName: 'Sarah',
      realName: 'Sarah K',
      userName: 'sarah',
    });
    const r = new NameResolver();
    const out = await r.rewriteMentions('ping <@U999>', makeClient({ usersInfo }));
    expect(out).toBe('ping <@U999>');
    expect(usersInfo).toHaveBeenCalledTimes(1);
    // The name was cached as a side effect (used by flattenToNames / table cells).
    expect(r.getUser('U999')).toBe('Sarah');
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
    expect(out).toBe('<@U042> in <#C100> told <@U999> to look');
    expect(usersInfo).toHaveBeenCalledTimes(1); // only U999, not U042
  });

  it('is a no-op on empty input', async () => {
    const r = new NameResolver();
    expect(await r.rewriteMentions('', makeClient())).toBe('');
  });
});

describe('NameResolver.rewriteMentionsCached', () => {
  it('preserves canonical tokens regardless of cache state', () => {
    const r = new NameResolver();
    r.primeForTests({ U042: 'Amit' }, { C100: 'general' });
    // `<@U…>` / `<#C…>` are passed through (cached or not) — Slack renders them.
    expect(r.rewriteMentionsCached('<@U042> in <#C100> mentioned <@U999>')).toBe(
      '<@U042> in <#C100> mentioned <@U999>',
    );
  });

  it('rewrites a cached `<#D…>` DM link to its counterpart token', () => {
    const r = new NameResolver();
    r.primeForTests({ U777: 'Sarah' }, {}, { D04ABC: 'U777' });
    expect(r.rewriteMentionsCached('in <#D04ABC|dm>')).toBe('in <@U777>');
  });
});

describe('NameResolver.flattenToNames', () => {
  it('flattens tokens to plain names for non-mrkdwn surfaces (titles)', () => {
    const r = new NameResolver();
    r.primeForTests({ U042: 'Amit', U777: 'Sarah' }, { C100: 'general' }, { D04ABC: 'U777' });
    expect(r.flattenToNames('<@U042> in <#C100> dм <#D04ABC|x>')).toBe(
      '@Amit in #general dм @Sarah',
    );
  });

  it('drops unknown ids rather than leaking them into a title', () => {
    const r = new NameResolver();
    expect(r.flattenToNames('hi <@U999> see <#C404>')).toBe('hi  see ');
  });
});

describe('NameResolver.resolveDmParticipant', () => {
  it('maps a `D…` channel id to its counterpart display name and caches it', async () => {
    const conversationsInfo = vi
      .fn()
      .mockResolvedValue({ id: 'D04ABC', isIm: true, isMpim: false, userId: 'U777' });
    const usersInfo = vi.fn().mockResolvedValue({ displayName: 'Sarah' });
    const r = new NameResolver();
    const client = makeClient({ conversationsInfo, usersInfo });
    expect(await r.resolveDmParticipant('D04ABC', client)).toBe('Sarah');
    expect(r.getDmParticipant('D04ABC')).toEqual({ userId: 'U777', name: 'Sarah' });
    // Second call is fully cached — no extra API calls.
    await r.resolveDmParticipant('D04ABC', client);
    expect(conversationsInfo).toHaveBeenCalledTimes(1);
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for an MPIM (no single counterpart) without leaking', async () => {
    const conversationsInfo = vi
      .fn()
      .mockResolvedValue({ id: 'D04ABC', isIm: false, isMpim: true });
    const r = new NameResolver();
    expect(
      await r.resolveDmParticipant('D04ABC', makeClient({ conversationsInfo })),
    ).toBeUndefined();
  });

  it('sticky-caches a definitive channel_not_found miss', async () => {
    const conversationsInfo = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    const r = new NameResolver();
    const client = makeClient({ conversationsInfo });
    expect(await r.resolveDmParticipant('DGONE', client)).toBeUndefined();
    expect(await r.resolveDmParticipant('DGONE', client)).toBeUndefined();
    expect(conversationsInfo).toHaveBeenCalledTimes(1); // sticky — not retried
  });

  it('does NOT sticky-cache a transient failure', async () => {
    const conversationsInfo = vi.fn().mockRejectedValue(new Error('rate_limited'));
    const r = new NameResolver();
    const client = makeClient({ conversationsInfo });
    expect(await r.resolveDmParticipant('DTEMP', client)).toBeUndefined();
    expect(await r.resolveDmParticipant('DTEMP', client)).toBeUndefined();
    expect(conversationsInfo).toHaveBeenCalledTimes(2); // retried
  });
});

describe('NameResolver.populateUsers', () => {
  it('warms the user cache; skips deleted members; resolves become sync', async () => {
    const usersList = vi.fn().mockResolvedValue({
      users: [
        { id: 'U042', displayName: 'Amit' },
        { id: 'U777', realName: 'Sarah K' },
        { id: 'UGONE', displayName: 'Ghost', deleted: true },
      ],
    });
    const r = new NameResolver();
    await r.populateUsers(makeClient({ usersList }));
    expect(r.getUser('U042')).toBe('Amit');
    expect(r.getUser('U777')).toBe('Sarah K');
    expect(r.getUser('UGONE')).toBeUndefined();
  });

  it('swallows API failure and continues in lazy mode', async () => {
    const usersList = vi.fn().mockRejectedValue(new Error('rate_limited'));
    const r = new NameResolver();
    await expect(r.populateUsers(makeClient({ usersList }))).resolves.not.toThrow();
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
