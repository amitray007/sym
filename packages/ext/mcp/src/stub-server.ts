/**
 * Stub (no-op) in-process MCP server for E2E tests.
 *
 * Implements the McpTransport interface directly — no network, no process
 * spawn.  Tests inject this as the transport for McpClient.
 *
 * By default every tool returns `{ content: "stub-ok", isError: false }`.
 * Tests can override `tools` and `callHandler` for richer scenarios.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpCallResult,
  McpToolInfo,
  McpTransport,
} from './types.js';
import type { JsonObject, JsonValue } from '@sym/contracts';

export interface StubServerOptions {
  /**
   * Tools to advertise on `tools/list`.
   * Defaults to an empty list.
   */
  tools?: McpToolInfo[];
  /**
   * Optional override for `tools/call`.
   * Receives the tool name and arguments, returns McpCallResult.
   */
  callHandler?: (name: string, args: JsonObject) => McpCallResult | Promise<McpCallResult>;
}

let stubIdCounter = 0;

export class StubMcpTransport implements McpTransport {
  private readonly tools: McpToolInfo[];
  private readonly callHandler: (
    name: string,
    args: JsonObject,
  ) => McpCallResult | Promise<McpCallResult>;
  private closed = false;

  constructor(opts: StubServerOptions = {}) {
    this.tools = opts.tools ?? [];
    this.callHandler =
      opts.callHandler ?? ((_name, _args) => ({ content: 'stub-ok', isError: false }));
  }

  async request(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.closed) {
      return this.error(req.id, -32_603, 'Stub transport is closed');
    }

    switch (req.method) {
      case 'initialize':
        return this.ok(req.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sym-stub-mcp', version: '0.0.0' },
        });

      case 'notifications/initialized':
        // Fire-and-forget notification — acknowledge with a dummy response
        // (the client ignores protocol errors for notifications).
        return this.ok(req.id, null);

      case 'tools/list':
        return this.ok(req.id, { tools: this.tools as unknown as JsonValue });

      case 'tools/call': {
        const params = req.params ?? {};
        const name = params['name'] as string | undefined;
        const args = (params['arguments'] as JsonObject | undefined) ?? {};
        if (typeof name !== 'string') {
          return this.error(req.id, -32_602, 'tools/call: missing name');
        }
        const knownTool = this.tools.find((t) => t.name === name);
        if (!knownTool) {
          return this.error(req.id, -32_602, `tools/call: unknown tool ${name}`);
        }
        const result: McpCallResult = await this.callHandler(name, args);
        return this.ok(req.id, result as unknown as JsonValue);
      }

      default:
        return this.error(req.id, -32_601, `Method not found: ${req.method}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private ok(id: JsonRpcRequest['id'], result: JsonValue): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

// Re-export counter reset for test isolation
export function resetStubIdCounter(): void {
  stubIdCounter = 0;
}
