/**
 * mcp/cli-config.ts — Helpers for reading the `cli` section from the Sym
 * config file (.sym/config.json).
 *
 * All three callers (`loadCliAllow`, `loadCliDescribe`, and any future `cli`
 * readers) share a single `readConfigFile()` primitive that reads + parses the
 * file ONCE per call-site invocation. Previously `source.ts` had a private
 * `readCliSection()` that called `readFileSync` on every invocation of
 * `loadCliAllow` or `loadCliDescribe`, causing 3–5× per-turn re-reads when
 * both functions were called in the same request path. Now callers that need
 * both values can pass the same parsed object in, or callers that need only
 * one value pay exactly one read each.
 *
 * File shape (v1):
 * ```json
 * { "version": 1, "mcpServers": […], "cli": { "allow": […], "describe": { … } } }
 * ```
 */

import { readFileSync } from 'node:fs';

import { configPath } from './source.js';

// ---------------------------------------------------------------------------
// Shared file-read primitive (Z08-08 dedup)
// ---------------------------------------------------------------------------

/**
 * Read and JSON-parse the Sym config file once.
 *
 * Returns the parsed file object, or `undefined` when the file is absent,
 * unreadable, or contains non-object JSON. Fail-open — never throws.
 *
 * Callers that need multiple fields from the config in the same request path
 * should call this once and pass the result to individual section extractors.
 */
export function readConfigFile(): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CLI section extractor
// ---------------------------------------------------------------------------

/**
 * Extract the `cli` object from an already-parsed config file.
 *
 * Returns `undefined` when the `cli` field is absent or not a plain object.
 * Pass the result of `readConfigFile()` to avoid redundant file reads.
 */
function extractCliSection(
  configObj: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (configObj === undefined) return undefined;
  const cli = configObj['cli'];
  if (cli === null || typeof cli !== 'object' || Array.isArray(cli)) return undefined;
  return cli as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public helpers (each reads the file once via readConfigFile)
// ---------------------------------------------------------------------------

/**
 * Read the run_cli allowlist from the config file's `cli.allow` array, or
 * `undefined` when the file/field is absent or malformed (caller falls back to
 * the `SYM_CLI_ALLOWLIST` env var). Fail-open — never throws.
 *
 * File shape: `{ …, "cli": { "allow": ["sym","gcloud"], "describe": { "gcloud": "…" } } }`.
 * An `allow` entry of `"*"` means "any CLI" (wildcard).
 */
export function loadCliAllow(): string[] | undefined {
  const cli = extractCliSection(readConfigFile());
  if (cli === undefined) return undefined;
  const allow = cli['allow'];
  if (!Array.isArray(allow) || !allow.every((s) => typeof s === 'string')) return undefined;
  return allow as string[];
}

/**
 * Read per-CLI descriptions (`cli.describe`) — what each binary is for, so the
 * agent knows a CLI's purpose without it being hardcoded anywhere. Fail-open.
 */
export function loadCliDescribe(): Record<string, string> {
  const cli = extractCliSection(readConfigFile());
  const describe = cli?.['describe'];
  if (describe === null || typeof describe !== 'object' || Array.isArray(describe)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(describe as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}
