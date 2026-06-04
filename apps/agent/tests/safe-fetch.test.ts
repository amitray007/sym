import { describe, expect, it, vi } from 'vitest';

import { assertPublicHost, isBlockedAddress, safeFetch } from '../src/safe-fetch.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '::1',
    'fe80::1', // link-local
    'fc00::1', // unique-local
    'fd12:3456::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::1', '172.32.0.1', '11.0.0.1'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it('blocks a malformed address (fail closed)', () => {
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
  });
});

describe('assertPublicHost', () => {
  it('rejects a hostname that resolves to a private address', async () => {
    const lookupFn = vi.fn().mockResolvedValue(['10.1.2.3']);
    await expect(assertPublicHost('evil.example.com', lookupFn)).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it('rejects when ANY resolved address is private (mixed result)', async () => {
    const lookupFn = vi.fn().mockResolvedValue(['93.184.216.34', '127.0.0.1']);
    await expect(assertPublicHost('rebind.example.com', lookupFn)).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it('allows a hostname that resolves to a public address', async () => {
    const lookupFn = vi.fn().mockResolvedValue(['93.184.216.34']);
    await expect(assertPublicHost('example.com', lookupFn)).resolves.toBeUndefined();
  });

  it('rejects a literal private IP host without any DNS lookup', async () => {
    const lookupFn = vi.fn();
    await expect(assertPublicHost('169.254.169.254', lookupFn)).rejects.toThrow(
      /private\/reserved/,
    );
    expect(lookupFn).not.toHaveBeenCalled();
  });
});

describe('safeFetch', () => {
  const publicLookup = async () => ['93.184.216.34'];

  it('rejects a non-http(s) scheme', async () => {
    await expect(
      safeFetch('file:///etc/passwd', {}, { fetchImpl: vi.fn(), lookupFn: publicLookup }),
    ).rejects.toThrow(/non-http/);
  });

  it('blocks a redirect that points at an internal host', async () => {
    const fetchImpl = vi
      .fn()
      // first hop: public, returns a redirect to an internal host
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      });
    const lookupFn = async (h: string) => (h === 'example.com' ? ['93.184.216.34'] : ['10.0.0.1']);
    await expect(
      safeFetch(
        'https://example.com/',
        {},
        { fetchImpl: fetchImpl as unknown as typeof fetch, lookupFn },
      ),
    ).rejects.toThrow(/private\/reserved/);
    // The internal hop is never actually fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to another public host and returns the final response', async () => {
    const final = { status: 200, headers: new Headers() };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: 'https://b.example.com/' }),
      })
      .mockResolvedValueOnce(final);
    const res = await safeFetch(
      'https://a.example.com/',
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, lookupFn: publicLookup },
    );
    expect(res).toBe(final);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // redirect:'manual' is forced regardless of caller init.
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).redirect).toBe('manual');
  });

  it('throws on a redirect loop past the cap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: 'https://a.example.com/' }),
    });
    await expect(
      safeFetch(
        'https://a.example.com/',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          lookupFn: publicLookup,
          maxRedirects: 2,
        },
      ),
    ).rejects.toThrow(/too many redirects/);
  });
});
