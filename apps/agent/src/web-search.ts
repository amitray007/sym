/**
 * web_search — keyless web search via DuckDuckGo's HTML endpoint.
 *
 * No API key (per the deploy's "no keys" choice). Best-effort: DuckDuckGo may
 * rate-limit datacenter IPs or change its markup, so callers must handle an
 * empty result gracefully. Uses the SSRF-guarded safeFetch for the request.
 *
 * Reliability upgrade path (if the keyless endpoint gets flaky in prod): point
 * at a self-hosted SearXNG JSON API, or switch to a keyed provider.
 */

import { safeFetch, type LookupFn, type SafeFetchOptions } from './safe-fetch.js';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 10_000;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo wraps result links as `//duckduckgo.com/l/?uddg=<encoded>&rut=…`. */
function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m?.[1] !== undefined) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through to raw href */
    }
  }
  if (href.startsWith('//')) return `https:${href}`;
  return href;
}

/** Parse DuckDuckGo HTML results into a ranked list. Pure — unit-testable. */
export function parseDdgHtml(html: string, limit: number): WebResult[] {
  const snippets: string[] = [];
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(sm[1] ?? ''));
  }

  const results: WebResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
    const title = stripTags(lm[2] ?? '');
    if (title.length > 0) {
      results.push({ title, url: decodeDdgUrl(lm[1] ?? ''), snippet: snippets[i] ?? '' });
    }
    i += 1;
  }
  return results;
}

export async function webSearch(
  query: string,
  opts: { limit?: number; fetchImpl?: typeof fetch; lookupFn?: LookupFn } = {},
): Promise<WebResult[]> {
  const limit = opts.limit ?? 8;
  const q = query.trim();
  if (q.length === 0) return [];

  const fetchOpts: SafeFetchOptions = {};
  if (opts.fetchImpl !== undefined) fetchOpts.fetchImpl = opts.fetchImpl;
  if (opts.lookupFn !== undefined) fetchOpts.lookupFn = opts.lookupFn;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await safeFetch(
      `${DDG_ENDPOINT}?q=${encodeURIComponent(q)}`,
      {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: controller.signal,
      },
      fetchOpts,
    );
    return parseDdgHtml(await res.text(), limit);
  } finally {
    clearTimeout(timer);
  }
}
