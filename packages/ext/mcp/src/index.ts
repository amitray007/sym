/**
 * `@sym/ext-mcp` — MCP extension layer.
 *
 * Public API:
 *  Transports:
 *    - HttpMcpTransport   — JSON-RPC over HTTP (streaming-aware)
 *    - StdioMcpTransport  — JSON-RPC over stdio (Content-Length framing)
 *  Client:
 *    - McpClient          — typed MCP protocol client
 *  Registry / Dispatcher:
 *    - McpToolRegistry    — ToolDispatcher impl; wraps N MCP servers
 *  Auth store:
 *    - InMemoryMcpAuthStore — injectable challenge-driven OAuth session store
 *  Stub:
 *    - StubMcpTransport   — in-process stub for E2E tests
 *  Types:
 *    - McpTransport, McpAuthStore, McpAuthSession, McpServerConfig, etc.
 */

export { HttpMcpTransport } from './transport-http.js';
export type { FetchFn, HttpTransportOptions } from './transport-http.js';

export { StdioMcpTransport } from './transport-stdio.js';
export type { StdioTransportOptions } from './transport-stdio.js';

export { McpClient, McpProtocolError } from './client.js';

export { McpToolRegistry } from './registry.js';
export type { AuditDb, AuditFn, TransportFactory } from './registry.js';

export { InMemoryMcpAuthStore } from './auth-store.js';

export { StubMcpTransport, resetStubIdCounter } from './stub-server.js';
export type { StubServerOptions } from './stub-server.js';

export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  McpToolInfo,
  McpCallResult,
  McpTransport,
  McpAuthStore,
  McpAuthSession,
  McpServerConfig,
} from './types.js';
export { McpTransportError } from './types.js';
