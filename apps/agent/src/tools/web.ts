/**
 * Built-in tools: fetch_url, web_search, run_cli.
 *
 * External-data tools: fetching web pages, searching DuckDuckGo, and running
 * allowlisted CLI commands. None require Slack token routing. `fetch_url` is
 * SSRF-guarded via `safe-fetch.ts`.
 */

import { runCli } from '../run-cli.js';
import { safeFetch } from '../safe-fetch.js';
import { webSearch } from '../web-search.js';
import { argError, errMsg, stripHtmlToText } from './_helpers.js';

import type { JsonSchema, ToolCall, ToolDescriptor, ToolResult } from '@sym/contracts';

/** Hard ceiling on fetch_url response size (chars after HTML strip). */
const FETCH_URL_DEFAULT_MAX = 8000;
/** Network timeout for fetch_url, in ms. */
const FETCH_URL_TIMEOUT_MS = 10_000;

export const FETCH_URL_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'fetch_url',
  // READ tool: arbitrary http(s) fetch with HTML stripped to text. No JS rendering.
  description:
    'Fetch a web URL and return its text content (HTML stripped). Use to read docs, articles, or pages a user links to. Only http(s) URLs; 10s timeout; output is truncated.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL',
      },
      max_chars: {
        type: 'number',
        description: `Truncation cap (default ${FETCH_URL_DEFAULT_MAX})`,
      },
    },
    required: ['url'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

export const WEB_SEARCH_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'web_search',
  // READ tool: keyless DuckDuckGo web search. Returns ranked title/url/snippet.
  description:
    'Search the web (DuckDuckGo, no API key). Returns ranked results with title, URL, and snippet. Use for current information, finding docs, or locating a URL to then read with fetch_url. Best-effort — may occasionally return nothing.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 8, max 10)' },
    },
    required: ['query'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

export const RUN_CLI_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'run_cli',
  // Runs an allowlisted CLI by argv (no shell). NOT confirm-gated (no
  // destructiveHint) — the binary allowlist (SYM_CLI_ALLOWLIST) is the boundary.
  description:
    'Run an allowlisted command-line tool (e.g. sym, gog, gcloud, sentry-cli, gh, jq) by argv array — no shell, so no pipes/redirects. To inspect YOUR OWN connectors + tools, run ["sym","status"], ["sym","tools"], or ["sym","show","<connector>"] (add "--json" for structured output). To learn a CLI you do not know, FIRST run it with --help (e.g. ["gog","gmail","--help"]) or "<subcommand> --help", then run the real command. Returns stdout, stderr, and exit code. argv[0] must be a bare allowlisted binary name.',
  parameters: {
    type: 'object',
    properties: {
      argv: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command and arguments, e.g. ["gcloud","run","services","list"]',
      },
    },
    required: ['argv'],
    additionalProperties: false,
  } satisfies JsonSchema,
};

export async function handleFetchUrl(call: ToolCall): Promise<ToolResult> {
  const urlArg = call.arguments['url'];
  if (typeof urlArg !== 'string' || urlArg.length === 0) {
    return argError(call, 'url must be a non-empty string');
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(urlArg);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return argError(call, 'url must be an absolute http(s) URL');
  }
  const maxCharsArg = call.arguments['max_chars'];
  const maxChars = Math.max(
    200,
    typeof maxCharsArg === 'number' ? maxCharsArg : FETCH_URL_DEFAULT_MAX,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
  try {
    // SSRF-guarded: blocks private/reserved/metadata hosts and
    // re-validates every redirect hop. See safe-fetch.ts.
    const res = await safeFetch(parsed.toString(), {
      signal: controller.signal,
      headers: { 'user-agent': 'Sym/1.0 (+slack-agent)' },
    });
    if (!res.ok) {
      return {
        callId: call.id,
        ok: false,
        error: {
          code: 'execution_failed',
          message: `HTTP ${res.status} ${res.statusText}`,
        },
      };
    }
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const text = /html|xml/i.test(contentType) ? stripHtmlToText(raw) : raw.trim();
    const truncated =
      text.length > maxChars
        ? `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`
        : text;
    return { callId: call.id, ok: true, content: truncated };
  } catch (err: unknown) {
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
    const message = aborted ? `fetch timed out after ${FETCH_URL_TIMEOUT_MS}ms` : errMsg(err);
    return { callId: call.id, ok: false, error: { code: 'execution_failed', message } };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleWebSearch(call: ToolCall): Promise<ToolResult> {
  const queryArg = call.arguments['query'];
  if (typeof queryArg !== 'string' || queryArg.trim().length === 0) {
    return argError(call, 'query must be a non-empty string');
  }
  const limitArg = call.arguments['limit'];
  const limit = Math.max(1, Math.min(10, typeof limitArg === 'number' ? limitArg : 8));
  try {
    const hits = await webSearch(queryArg, { limit });
    if (hits.length === 0) {
      return {
        callId: call.id,
        ok: true,
        content: `No web results for "${queryArg.trim()}".`,
      };
    }
    const body = hits
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
      .join('\n');
    return { callId: call.id, ok: true, content: body };
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}

export async function handleRunCli(call: ToolCall): Promise<ToolResult> {
  const argvArg = call.arguments['argv'];
  if (
    !Array.isArray(argvArg) ||
    argvArg.length === 0 ||
    !argvArg.every((a) => typeof a === 'string')
  ) {
    return argError(call, 'argv must be a non-empty string array, e.g. ["gog","gmail","--help"]');
  }
  const argv = argvArg as string[];
  const r = await runCli(argv);
  if (r.error !== undefined && r.code === null && !r.timedOut) {
    // Allowlist/spawn failure — the command never ran.
    return { callId: call.id, ok: false, error: { code: 'execution_failed', message: r.error } };
  }
  const out = r.stdout.length > 0 ? `\nstdout:\n${r.stdout}` : '';
  const errOut = r.stderr.length > 0 ? `\nstderr:\n${r.stderr}` : '';
  // ok:true even on non-zero exit so the model can read stderr / --help
  // output and adapt (e.g. fix a wrong subcommand).
  return {
    callId: call.id,
    ok: true,
    content: `$ ${argv.join(' ')}\nexit: ${r.timedOut ? 'TIMEOUT' : r.code}${out}${errOut}`,
  };
}
