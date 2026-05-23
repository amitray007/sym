/**
 * McpClient — a stateful connection to one MCP server.
 *
 * Wraps a McpTransport and provides typed methods for the MCP protocol
 * subset used by the ToolDispatcher: `initialize`, `tools/list`, `tools/call`.
 *
 * The client allocates monotonically-increasing JSON-RPC request ids.
 */

import { isJsonRpcError, McpTransportError } from './types.js';

import type { JsonRpcRequest, McpCallResult, McpToolInfo, McpTransport } from './types.js';
import type { JsonObject, JsonValue } from '@sym/contracts';

export class McpProtocolError extends Error {
  constructor(
    message: string,
    public readonly rpcCode: number,
    public readonly rpcData?: JsonValue,
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

export class McpClient {
  private nextId = 1;
  private initialized = false;

  constructor(private readonly transport: McpTransport) {}

  /**
   * Send MCP `initialize` handshake.  Must be called before `listTools` or
   * `callTool`.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const res = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sym-ext-mcp', version: '0.0.0' },
    });

    // The initialize result is informational — we don't parse capabilities yet.
    if (isJsonRpcError(res)) {
      throw new McpProtocolError(
        `MCP initialize failed: ${res.error.message}`,
        res.error.code,
        res.error.data,
      );
    }

    // Send the initialized notification (fire-and-forget, no id)
    await this.notify('notifications/initialized');

    this.initialized = true;
  }

  async listTools(): Promise<McpToolInfo[]> {
    this.assertInitialized();
    const res = await this.rpc('tools/list');
    if (isJsonRpcError(res)) {
      throw new McpProtocolError(
        `tools/list failed: ${res.error.message}`,
        res.error.code,
        res.error.data,
      );
    }

    const result = res.result as { tools?: unknown };
    const tools = result.tools;
    if (!Array.isArray(tools)) {
      throw new McpProtocolError('tools/list: result.tools is not an array', -32_600);
    }

    return tools as McpToolInfo[];
  }

  async callTool(name: string, args: JsonObject): Promise<McpCallResult> {
    this.assertInitialized();
    const res = await this.rpc('tools/call', { name, arguments: args });

    if (isJsonRpcError(res)) {
      throw new McpProtocolError(
        `tools/call(${name}) failed: ${res.error.message}`,
        res.error.code,
        res.error.data,
      );
    }

    return res.result as unknown as McpCallResult;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async rpc(method: string, params?: JsonObject) {
    const id = this.nextId++;
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return this.transport.request(req);
  }

  /** Fire-and-forget notification (no id, no response expected). */
  private async notify(method: string, params?: JsonObject): Promise<void> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: null,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    try {
      await this.transport.request(req);
    } catch (err) {
      // Notifications don't have a response; a McpTransportError here is OK.
      if (!(err instanceof McpTransportError)) throw err;
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('McpClient: call initialize() before listTools() or callTool()');
    }
  }
}
