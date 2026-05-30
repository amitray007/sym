/**
 * MCP server config — parsed from the `MCP_SERVERS` env var.
 *
 * Shape (JSON array):
 * ```json
 * [
 *   {
 *     "name": "my-server",
 *     "command": "/usr/local/bin/my-mcp-server",
 *     "args": ["--flag"],
 *     "env": { "API_KEY": "..." },
 *     "trust": true
 *   }
 * ]
 * ```
 *
 * `trust: true` means the owner has explicitly opted this server's tools in
 * to skip the confirm-before-destructive gate. It MUST be owner-set in the
 * deployment env — never derived from server-reported annotations.
 *
 * The `transport` discriminant is ready for Chunk 2 (HTTP). Only `"stdio"` is
 * implemented here; an unknown transport is rejected at parse time, ensuring
 * the config shape is always well-typed before use.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Stdio MCP server — Chunk 1 transport.
 *
 * The `transport` field is explicit and required so Chunk 2 can add:
 * `{ transport: "http", url: string, headers?: Record<string,string>, trust?: boolean }`
 * without changing any existing code paths.
 */
export interface StdioMcpServerConfig {
  transport: 'stdio';
  /** Logical name — used as the tool-name prefix: `<name>__<toolName>`. */
  name: string;
  /** Executable path or name on PATH. */
  command: string;
  /** CLI arguments passed to the command. */
  args?: string[];
  /** Additional env vars merged into the child process environment. */
  env?: Record<string, string>;
  /**
   * Owner-set trust flag.
   *
   * When `true`, this server's tools skip the confirm-before-destructive gate.
   * The decision is owned by the deployment config (this file), NOT by any
   * hint the MCP server sends (`destructiveHint` / `readOnlyHint` are
   * attacker-controlled and MUST NOT influence the gate decision).
   *
   * Default: `false` — all MCP tools go through confirmation.
   */
  trust?: boolean;
}

/**
 * Union of all supported MCP server configs.
 *
 * Chunk 2 adds:
 * ```ts
 * export interface HttpMcpServerConfig {
 *   transport: 'http';
 *   name: string;
 *   url: string;
 *   headers?: Record<string, string>;
 *   trust?: boolean;
 * }
 * export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;
 * ```
 */
export type McpServerConfig = StdioMcpServerConfig;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse `MCP_SERVERS` (raw JSON string) into typed server configs.
 *
 * Fail-open: any malformed entry is logged and skipped; missing/empty env var
 * returns an empty array (no MCP tools, no crash). Invalid env never throws
 * into the server startup path.
 */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (raw === undefined || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[mcp] MCP_SERVERS is not valid JSON — ignoring all MCP servers:', err);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn('[mcp] MCP_SERVERS must be a JSON array — ignoring all MCP servers');
    return [];
  }

  const configs: McpServerConfig[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    const result = parseEntry(entry, i);
    if (result !== null) {
      configs.push(result);
    }
  }
  return configs;
}

function parseEntry(entry: unknown, index: number): McpServerConfig | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    console.warn(`[mcp] MCP_SERVERS[${index}] is not an object — skipping`);
    return null;
  }

  const e = entry as Record<string, unknown>;

  // Resolve transport — default to 'stdio' when absent for forwards compat.
  const transport = e['transport'] ?? 'stdio';

  if (transport !== 'stdio') {
    // Reserved for Chunk 2 (HTTP). Unknown transports are rejected cleanly.
    console.warn(
      `[mcp] MCP_SERVERS[${index}] has unsupported transport '${String(transport)}' — skipping (only 'stdio' is supported in this build)`,
    );
    return null;
  }

  const name = e['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    console.warn(`[mcp] MCP_SERVERS[${index}] missing required 'name' string — skipping`);
    return null;
  }

  const command = e['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    console.warn(
      `[mcp] MCP_SERVERS[${index}] ('${name}') missing required 'command' string — skipping`,
    );
    return null;
  }

  const args = parseStringArray(e['args'], `MCP_SERVERS[${index}].args`);
  if (args === false) return null; // logged inside

  const env = parseStringRecord(e['env'], `MCP_SERVERS[${index}].env`);
  if (env === false) return null; // logged inside

  const trust = e['trust'];
  if (trust !== undefined && typeof trust !== 'boolean') {
    console.warn(`[mcp] MCP_SERVERS[${index}] ('${name}') 'trust' must be a boolean — skipping`);
    return null;
  }

  const config: StdioMcpServerConfig = {
    transport: 'stdio',
    name: name.trim(),
    command,
    ...(args !== null ? { args } : {}),
    ...(env !== null ? { env } : {}),
    ...(trust === true ? { trust: true } : {}),
  };
  return config;
}

/** Returns the array, null (absent/undefined), or false (present but invalid). */
function parseStringArray(raw: unknown, label: string): string[] | null | false {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    console.warn(`[mcp] ${label} must be an array of strings — skipping entry`);
    return false;
  }
  return raw as string[];
}

/** Returns the record, null (absent/undefined), or false (present but invalid). */
function parseStringRecord(raw: unknown, label: string): Record<string, string> | null | false {
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !Object.values(raw as object).every((v) => typeof v === 'string')
  ) {
    console.warn(`[mcp] ${label} must be a Record<string,string> — skipping entry`);
    return false;
  }
  return raw as Record<string, string>;
}
