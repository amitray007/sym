/**
 * SSRF-guarded fetch for the `fetch_url` tool.
 *
 * The model decides what to fetch, and its inputs include UNTRUSTED Slack text
 * (and prior fetched page content). Without guarding, a prompt-injected URL —
 * or a public URL that 302-redirects internally — could reach loopback,
 * RFC1918, link-local, or the cloud metadata endpoint (169.254.169.254) and
 * exfiltrate the response into the reply.
 *
 * Guard: validate http(s), DNS-resolve the host and reject if ANY resolved
 * address is private/reserved, and follow redirects MANUALLY, re-validating
 * each hop's host (a naive scheme/host check is otherwise defeated by a
 * redirect).
 *
 * Residual: DNS rebinding (resolve→public for the check, then the OS re-resolves
 * →private at connect time) is not fully closed here — that needs connect-time
 * IP pinning, which conflicts with TLS hostname validation. The resolve+check +
 * manual-redirect approach closes the practical injection paths.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** Injectable host→addresses resolver (tests pass a fake; prod uses DNS). */
export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/** True if an IPv4 dotted-quad is in a private/reserved/loopback range. */
function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed → block (fail closed)
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 255 && b === 255) return true; // broadcast
  return false;
}

/** True if an IP literal (v4 or v6) targets a private/reserved/loopback range. */
export function isBlockedAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true; // loopback / unspecified
    const mapped = low.match(/(?:^|:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // ::ffff:a.b.c.d
    if (mapped) return ipv4Blocked(mapped[1]!);
    const head = low.replace(/^\[/, '').split(':')[0] ?? '';
    if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local (RFC 4193)
    if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local (RFC 4291)
    // ff00::/8 multicast (RFC 4291)
    if (/^ff/.test(head)) return true;
    // 2001:db8::/32 documentation/example range (RFC 3849)
    if (low.startsWith('2001:db8:')) return true;
    // 64:ff9b::/96 NAT64 well-known prefix (RFC 6052)
    if (low.startsWith('64:ff9b::')) return true;
    return false;
  }
  return true; // not a parseable IP → block
}

/**
 * Throw if `hostname` (a literal IP or a DNS name) resolves to any
 * private/reserved address.
 */
export async function assertPublicHost(
  hostname: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<void> {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  let addresses: string[];
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    addresses = await lookupFn(host);
    if (addresses.length === 0) throw new Error(`could not resolve host: ${hostname}`);
  }
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new Error(`blocked host ${hostname} → ${addr} (private/reserved address)`);
    }
  }
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  lookupFn?: LookupFn;
}

/**
 * Fetch `rawUrl` with SSRF protection: every hop must be http(s) AND resolve to
 * a public address. Redirects are followed manually so each Location is
 * re-validated. Throws on a blocked host, a non-http(s) hop, or too many
 * redirects.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = new URL(current);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`blocked non-http(s) URL: ${url.protocol}`);
    }
    await assertPublicHost(url.hostname, opts.lookupFn);

    const res = await doFetch(url.toString(), { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location === null || location === '') return res;
    current = new URL(location, url).toString(); // resolve relative redirects
  }
  throw new Error(`too many redirects (>${maxRedirects})`);
}
