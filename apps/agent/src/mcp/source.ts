/**
 * Connector config source — the single place that decides WHERE Sym's connector
 * wiring comes from. The control plane (the `sym` CLI / TUI, built later) writes
 * a JSON config file on the persistent volume; this loader reads it. Until that
 * file exists, the legacy `SYM_MCP_SERVERS` env var is the fallback, so nothing
 * breaks during the transition and a rollback keeps working.
 *
 * Precedence:
 *   1. config file at SYM_CONFIG_PATH (default `.sym/config.json`)  →  source: 'file'
 *   2. SYM_MCP_SERVERS env var (legacy)                            →  source: 'env'
 *   3. neither                                                     →  source: 'none'
 *
 * The file is the source of truth ONLY when it exists and parses to an object.
 * A present-but-malformed file is logged and falls through to env (fail-open) —
 * a bad edit must never strand the agent with zero connectors when env still has
 * a valid set. Secrets never live in this file; it holds wiring + secretRefs.
 *
 * File shape (v1):
 * ```json
 * { "version": 1, "mcpServers": [ <ConnectorConfig>, … ] }
 * ```
 */

import { readFileSync } from 'node:fs';

import { parseConnectorArray, parseMcpServers } from './config.js';

import type { ConnectorConfig } from './config.js';

/** Where the loaded config came from — surfaced in the boot log for "why no tools?" clarity. */
export type ConfigSource = 'file' | 'env' | 'none';

export interface LoadedConnectorConfig {
  mcpServers: ConnectorConfig[];
  source: ConfigSource;
  /** Absolute-ish path consulted for the file (for diagnostics). */
  path: string;
}

const DEFAULT_CONFIG_PATH = '.sym/config.json';

/** Resolve the config file path (overridable via `SYM_CONFIG_PATH`). */
export function configPath(): string {
  const raw = process.env['SYM_CONFIG_PATH'];
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : DEFAULT_CONFIG_PATH;
}

/**
 * Load connector configs from the config file, falling back to the legacy env
 * var. Fail-open at every step — this runs on the startup path and must never
 * throw.
 */
export function loadConnectorConfigs(): LoadedConnectorConfig {
  const path = configPath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No file (ENOENT) or unreadable — fall back to env. Not a warning: the
    // file is optional until the control plane writes one.
    return { ...fromEnv(), path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[mcp] config file ${path} is not valid JSON — falling back to env:`, err);
    return { ...fromEnv(), path };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      `[mcp] config file ${path} must be a JSON object { version, mcpServers } — falling back to env`,
    );
    return { ...fromEnv(), path };
  }

  const mcpServers = parseConnectorArray((parsed as Record<string, unknown>)['mcpServers'], path);
  return { mcpServers, source: 'file', path };
}

/** Legacy env-var source. Returns 'none' when the var is unset/empty. */
function fromEnv(): { mcpServers: ConnectorConfig[]; source: ConfigSource } {
  const rawEnv = process.env['SYM_MCP_SERVERS'];
  if (rawEnv === undefined || rawEnv.trim().length === 0) {
    return { mcpServers: [], source: 'none' };
  }
  return { mcpServers: parseMcpServers(rawEnv), source: 'env' };
}
