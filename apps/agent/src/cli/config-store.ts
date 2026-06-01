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

import { parseConnectorArray } from '../mcp/config.js';

import type { ConnectorConfig } from '../mcp/config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SymConfigFile {
  version: number;
  mcpServers: ConnectorConfig[];
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

  return { version, mcpServers };
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
