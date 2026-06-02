/**
 * MCP connector config — the public parse entry points.
 *
 * Parsed from the `SYM_MCP_SERVERS` env var or the `mcpServers` field of the
 * config file. The typed shapes live in `./config-types` (re-exported below so
 * `import { ConnectorConfig } from './mcp/config'` keeps working); the fail-open
 * internal parsers live in `./config-parsers`.
 *
 * Fail-open everywhere: any malformed entry is logged and skipped; a missing or
 * empty env var returns an empty array (no MCP tools, no crash). Invalid config
 * never throws into the server startup path.
 */

import { parseEntry } from './config-parsers.js';

import type { ConnectorConfig } from './config-types.js';

export type {
  AuthConfig,
  ConnectorConfig,
  Injection,
  SecretMaterial,
  TransportConfig,
} from './config-types.js';

/**
 * Parse `SYM_MCP_SERVERS` (raw JSON string) into typed connector configs.
 *
 * Fail-open: any malformed entry is logged and skipped; missing/empty env var
 * returns an empty array (no MCP tools, no crash). Invalid env never throws
 * into the server startup path.
 *
 * `secretRef` static creds and `prepare` are parsed structurally but fail
 * cleanly at connect time (not yet wired); everything else is implemented.
 */
export function parseMcpServers(raw: string | undefined): ConnectorConfig[] {
  if (raw === undefined || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[mcp] SYM_MCP_SERVERS is not valid JSON — ignoring all MCP servers:', err);
    return [];
  }

  return parseConnectorArray(parsed, 'SYM_MCP_SERVERS');
}

/**
 * Parse an already-decoded value (e.g. the `mcpServers` field of the config
 * file, or `JSON.parse(SYM_MCP_SERVERS)`) into typed connector configs.
 *
 * Fail-open: a non-array is logged and yields `[]`; each malformed entry is
 * logged and skipped. Never throws into startup.
 */
export function parseConnectorArray(
  parsed: unknown,
  label = 'connector config',
): ConnectorConfig[] {
  if (!Array.isArray(parsed)) {
    console.warn(`[mcp] ${label} must be a JSON array — ignoring all MCP servers`);
    return [];
  }

  const configs: ConnectorConfig[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const result = parseEntry(parsed[i], i);
    if (result !== null) {
      configs.push(result);
    }
  }
  return configs;
}
