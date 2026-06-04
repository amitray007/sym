/**
 * Config-store — read/write helpers for the Sym connector config file.
 *
 * The file lives at `.sym/config.json` (or wherever `SYM_CONFIG_PATH` points)
 * and holds the full wiring for all MCP connectors.  The running agent reads
 * this file via `src/mcp/source.ts`; these helpers are used by the `sym` CLI
 * to add, remove, and inspect connectors without hand-editing JSON.
 *
 * File shape (v1):
 * ```json
 * { "version": 1, "mcpServers": [ <ConnectorConfig>, … ] }
 * ```
 *
 * Validation contract:
 *  - `loadConfigFile`  is fail-strict for structural errors (bad JSON, non-object
 *    root), but delegates per-entry validation to `parseConnectorArray` which is
 *    fail-open (skips malformed entries, never throws).
 *  - `writeConfigFile` is fail-strict: if any connector in the array is rejected
 *    by `parseConnectorArray` (count mismatch) we refuse to persist, so the file
 *    on disk is always valid.
 *  - `upsertConnector` and `removeConnector` are pure — they never touch the FS.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseConnectorArray } from '@sym/mcp-runtime';

import type { ConnectorConfig } from '@sym/mcp-runtime';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SymConfigFile {
  version: number;
  mcpServers: ConnectorConfig[];
  /**
   * run_cli allowlist (bare binary names; `"*"` = any) + optional per-binary
   * descriptions (what each CLI is for). Managed by `sym cli`.
   */
  cli?: { allow: string[]; describe?: Record<string, string> };
}

// ---------------------------------------------------------------------------
// loadConfigFile
// ---------------------------------------------------------------------------

/**
 * Read and validate the Sym config file at `path`.
 *
 * - Absent file → returns `{ version: 1, mcpServers: [] }` (no error).
 * - Present file with malformed JSON → throws a clear `Error`.
 * - Present file whose top-level value is not a plain object (e.g. an array
 *   or `null`) → throws a clear `Error`.
 * - Per-entry validation is delegated to `parseConnectorArray`, which is
 *   fail-open: malformed entries are logged and skipped rather than thrown.
 */
export function loadConfigFile(path: string): SymConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // ENOENT or unreadable — treat as absent, return empty config.
    return { version: 1, mcpServers: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[config-store] ${path} is not valid JSON: ${String(err)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `[config-store] ${path} must be a JSON object { version, mcpServers } — got ${
        parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed
      }`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const version = typeof obj['version'] === 'number' ? obj['version'] : 1;
  const mcpServers = parseConnectorArray(obj['mcpServers'], path);
  const cli = readCliSection(obj['cli']);

  return { version, mcpServers, ...(cli !== undefined ? { cli } : {}) };
}

/** Parse the optional `cli: { allow, describe? }` section (ignored if malformed). */
function readCliSection(raw: unknown): SymConfigFile['cli'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const allow = obj['allow'];
  if (!Array.isArray(allow) || !allow.every((s) => typeof s === 'string')) return undefined;
  const describe = parseDescribe(obj['describe']);
  return { allow: allow as string[], ...(describe !== undefined ? { describe } : {}) };
}

/** Parse `cli.describe` (a string→string map), dropping non-string/empty values. */
function parseDescribe(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// writeConfigFile
// ---------------------------------------------------------------------------

/**
 * Validate and write a `SymConfigFile` to `path` as pretty-printed JSON.
 *
 * Validation: runs `parseConnectorArray` on `cfg.mcpServers`; if the result
 * length differs from the input length, one or more connectors are invalid and
 * we throw rather than persist a truncated/broken file.
 *
 * The parent directory is created with `mkdir -p` semantics if absent.
 *
 * The written file always ends with a trailing newline.
 */
export function writeConfigFile(path: string, cfg: SymConfigFile): void {
  const validated = parseConnectorArray(cfg.mcpServers, path);
  if (validated.length !== cfg.mcpServers.length) {
    const dropped = cfg.mcpServers.length - validated.length;
    throw new Error(
      `[config-store] ${dropped} connector(s) in mcpServers are invalid — refusing to write ${path}`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// upsertConnector (pure)
// ---------------------------------------------------------------------------

/**
 * Return a new `SymConfigFile` with `connector` inserted or replaced.
 *
 * If an entry with the same `name` already exists it is replaced in-place;
 * otherwise `connector` is appended. The input `cfg` is never mutated.
 */
export function upsertConnector(cfg: SymConfigFile, connector: ConnectorConfig): SymConfigFile {
  const idx = cfg.mcpServers.findIndex((s) => s.name === connector.name);
  const mcpServers =
    idx === -1
      ? [...cfg.mcpServers, connector]
      : cfg.mcpServers.map((s, i) => (i === idx ? connector : s));
  return { ...cfg, mcpServers };
}

// ---------------------------------------------------------------------------
// setConnectorTrust (pure)
// ---------------------------------------------------------------------------

/**
 * Return a new `SymConfigFile` with the `trust` flag set on the MCP connector
 * named `name`. `trust: true` skips the confirm-before-destructive gate for that
 * server's tools; `false` drops the field (default is untrusted). The input
 * `cfg` is never mutated; an unknown name is a no-op.
 */
export function setConnectorTrust(cfg: SymConfigFile, name: string, value: boolean): SymConfigFile {
  return {
    ...cfg,
    mcpServers: cfg.mcpServers.map((s) => {
      if (s.name !== name) return s;
      if (value) return { ...s, trust: true };
      const next = { ...s };
      delete next.trust;
      return next;
    }),
  };
}

// ---------------------------------------------------------------------------
// removeConnector (pure)
// ---------------------------------------------------------------------------

/**
 * Return a new `SymConfigFile` with the connector named `name` removed.
 *
 * `removed` is `true` when the entry existed, `false` when it was not found.
 * The input `cfg` is never mutated.
 */
export function removeConnector(
  cfg: SymConfigFile,
  name: string,
): { next: SymConfigFile; removed: boolean } {
  const idx = cfg.mcpServers.findIndex((s) => s.name === name);
  if (idx === -1) {
    return { next: cfg, removed: false };
  }
  const mcpServers = cfg.mcpServers.filter((_, i) => i !== idx);
  return { next: { ...cfg, mcpServers }, removed: true };
}

// ---------------------------------------------------------------------------
// CLI allowlist (run_cli) — managed by `sym cli`
// ---------------------------------------------------------------------------

/** Dedupe + trim + drop empties, preserving order. */
function clean(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (v.length > 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Keep only the describe entries whose key satisfies `keep` (or undefined if empty). */
function pruneDescribe(
  describe: Record<string, string> | undefined,
  keep: (bin: string) => boolean,
): Record<string, string> | undefined {
  if (describe === undefined) return undefined;
  const out = Object.fromEntries(Object.entries(describe).filter(([k]) => keep(k)));
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Return a new config with the run_cli allowlist set to `allow` (pure). Prunes
 *  descriptions to the surviving binaries. */
export function setCliAllow(cfg: SymConfigFile, allow: string[]): SymConfigFile {
  const cleaned = clean(allow);
  const keep = new Set(cleaned);
  const describe = pruneDescribe(cfg.cli?.describe, (b) => keep.has(b));
  return { ...cfg, cli: { allow: cleaned, ...(describe !== undefined ? { describe } : {}) } };
}

/** Set a binary's description, e.g. "Google Cloud Platform CLI" (pure). */
export function setCliDesc(cfg: SymConfigFile, bin: string, desc: string): SymConfigFile {
  const allow = cfg.cli?.allow ?? [];
  const describe = { ...(cfg.cli?.describe ?? {}), [bin.trim()]: desc.trim() };
  return { ...cfg, cli: { allow, describe } };
}

/** Remove binaries from the allowlist (and their descriptions); reports which
 *  were present (pure). */
export function removeCli(
  cfg: SymConfigFile,
  bins: string[],
): { next: SymConfigFile; removed: string[] } {
  const current = cfg.cli?.allow ?? [];
  const drop = new Set(bins.map((b) => b.trim()));
  const kept = current.filter((b) => !drop.has(b));
  const removed = current.filter((b) => drop.has(b));
  const describe = pruneDescribe(cfg.cli?.describe, (b) => !drop.has(b));
  return {
    next: { ...cfg, cli: { allow: kept, ...(describe !== undefined ? { describe } : {}) } },
    removed,
  };
}
