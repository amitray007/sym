/**
 * web_search — keyless DuckDuckGo search.
 *
 * Covers the fragile HTML parser (the main risk) and the full webSearch path
 * with injected fetch + DNS so it runs offline.
 */

import { describe, expect, it } from 'vitest';

import { parseDdgHtml, webSearch } from '../src/web-search.js';

import type { LookupFn } from '../src/safe-fetch.js';

const FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example <b>Docs</b></a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>official</b> docs for Example.</a>
  </div>
</div>
<div class="result results_links">
  <div class="links_main">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.org%2Fa%3Fx%3D1&rut=def">Foo Org</a>
    <a class="result__snippet">Foo snippet here.</a>
  </div>
</div>
`;

describe('parseDdgHtml', () => {
  it('extracts title, decoded url, and snippet', () => {
    const r = parseDdgHtml(FIXTURE, 10);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      title: 'Example Docs',
      url: 'https://example.com/docs',
      snippet: 'The official docs for Example.',
    });
    expect(r[1]?.url).toBe('https://foo.org/a?x=1');
    expect(r[1]?.title).toBe('Foo Org');
  });

  it('respects the limit', () => {
    expect(parseDdgHtml(FIXTURE, 1)).toHaveLength(1);
  });

  it('returns [] for html with no results', () => {
    expect(parseDdgHtml('<html><body>nothing here</body></html>', 5)).toEqual([]);
  });
});

describe('webSearch', () => {
  const lookupFn: LookupFn = async () => ['1.2.3.4']; // public IP → passes SSRF guard

  it('fetches and parses (injected fetch + dns, no network)', async () => {
    const fetchImpl = (async () =>
      new Response(FIXTURE, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    const r = await webSearch('example docs', { fetchImpl, lookupFn, limit: 5 });
    expect(r).toHaveLength(2);
    expect(r[0]?.title).toBe('Example Docs');
    expect(r[0]?.url).toBe('https://example.com/docs');
  });

  it('returns [] for an empty query without fetching', async () => {
    expect(await webSearch('   ')).toEqual([]);
  });
});
