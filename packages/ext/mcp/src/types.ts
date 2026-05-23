/**
 * Internal MCP types — JSON-RPC 2.0 over HTTP or stdio.
 *
 * We do not import the official MCP SDK; instead we define the minimal subset
 * needed for the Sym dispatcher.  This keeps the dependency footprint small and
 * lets us swap transports without an SDK upgrade.
 */

import type { JsonObject, JsonValue } from '@sym/contracts';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: JsonValue;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export function isJsonRpcError(r: JsonRpcResponse): r is JsonRpcErrorResponse {
  return 'error' in r;
}

// ---------------------------------------------------------------------------
// MCP tool shapes (subset of MCP spec)
// ---------------------------------------------------------------------------

/** A raw MCP tool descriptor returned by `tools/list`. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

/** Result of `tools/call`. */
export interface McpCallResult {
  content: JsonValue;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * A low-level MCP transport.  Higher layers call `request()` and never
 * touch JSON-RPC framing directly.
 */
export interface McpTransport {
  /**
   * Send a JSON-RPC request and return the parsed response.
   * Throws `McpTransportError` on protocol or network errors.
   */
  request(req: JsonRpcRequest): Promise<JsonRpcResponse>;

  /** Release resources (close HTTP connections / kill stdio process). */
  close(): Promise<void>;
}

export class McpTransportError extends Error {
  constructor(
    message: string,
    public readonly code: 'network' | 'protocol' | 'timeout' | 'closed',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'McpTransportError';
  }
}

// ---------------------------------------------------------------------------
// MCP auth session store (challenge-driven OAuth, per oauth-flows-spec.md)
// ---------------------------------------------------------------------------

/**
 * Persists MCP OAuth sessions across the browser redirect.
 *
 * Key pattern: `mcp_auth:<state>` (random hex, TTL 10 min as per spec).
 * Implementations: in-memory (now) and Redis (later — see redis-todo.md note).
 */
export interface McpAuthStore {
  /**
   * Persist an auth session.  Expires after `ttlMs` (default 10 minutes).
   */
  set(state: string, session: McpAuthSession, ttlMs?: number): Promise<void>;

  /**
   * Retrieve and (optionally) consume an auth session.
   * Returns `undefined` when not found or expired.
   */
  get(state: string): Promise<McpAuthSession | undefined>;

  /**
   * Delete a session (one-time use after callback).
   */
  delete(state: string): Promise<void>;
}

export interface McpAuthSession {
  /** The plugin/provider this auth challenge belongs to. */
  provider: string;
  /** Slack user who triggered the auth challenge. */
  userId: string;
  /** The PKCE code verifier or other SDK-managed state. */
  codeVerifier?: string;
  /** Arbitrary SDK state the MCP auth flow needs. */
  sdkState?: JsonObject;
  /** ISO timestamp when this session was created. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// MCP server config (from `mcpConfigs` DB row — mirrors DB schema)
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  transport: 'http' | 'stdio';
  /** Required when transport === 'http'. */
  url?: string;
  /** Optional static headers for HTTP transport. */
  headers?: Record<string, string>;
  /** Required when transport === 'stdio'. */
  command?: string;
  args?: string[];
  /** Env vars for stdio process (decrypted before passing here). */
  env?: Record<string, string>;
}
