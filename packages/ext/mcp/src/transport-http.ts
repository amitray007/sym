/**
 * MCP HTTP transport — JSON-RPC 2.0 over HTTP with streaming support.
 *
 * The MCP spec allows servers to return a streaming (SSE or chunked) response
 * for long-running tool calls.  Here we handle two cases:
 *  - `application/json`: parse the body once as a JSON-RPC response.
 *  - `text/event-stream`: read SSE frames until we receive a message frame
 *    that contains a JSON-RPC response, then return it.
 *
 * Real credentials are never sent here — the sandbox egress proxy injects auth
 * headers for declared provider domains before the request leaves the host.
 */

import { McpTransportError } from './types.js';

import type { JsonRpcRequest, JsonRpcResponse, McpTransport } from './types.js';

/** Injectable fetch function (defaults to global fetch; swap in tests). */
export type FetchFn = typeof fetch;

export interface HttpTransportOptions {
  url: string;
  /** Static non-Authorization headers (e.g. X-Workspace). */
  headers?: Record<string, string>;
  /** Timeout in ms for a single request (default: 30_000). */
  timeoutMs?: number;
  /** Injectable fetch implementation (defaults to globalThis.fetch). */
  fetchFn?: FetchFn;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * JSON-RPC 2.0 over HTTP transport.
 *
 * POST each request to `url` with `Content-Type: application/json`.
 * Handles both `application/json` and `text/event-stream` responses.
 */
export class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private closed = false;
  /** Mcp-Session-Id captured from the server; echoed on all subsequent requests. */
  private sessionId: string | null = null;

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async request(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw new McpTransportError('Transport is closed', 'closed');
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);

    // Echo the session-id when we have one (MCP spec §session continuity).
    const sessionHeader: Record<string, string> =
      this.sessionId !== null ? { 'Mcp-Session-Id': this.sessionId } : {};

    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
          ...sessionHeader,
        },
        body: JSON.stringify(req),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as { name?: string }).name === 'AbortError') {
        throw new McpTransportError('MCP HTTP request timed out', 'timeout', { cause: err });
      }
      throw new McpTransportError(`MCP HTTP request failed: ${String(err)}`, 'network', {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new McpTransportError(`MCP server returned HTTP ${res.status.toString()}`, 'network');
    }

    // Capture Mcp-Session-Id from the response (notably on `initialize`).
    // Once set, it is echoed on all subsequent requests for session continuity.
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null && sid.length > 0) {
      this.sessionId = sid;
    }

    const contentType = res.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      return this.readSseResponse(res);
    }

    // Default: application/json
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new McpTransportError(`Failed to read MCP response body: ${String(err)}`, 'network', {
        cause: err,
      });
    }

    return this.parseJsonResponse(text);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async readSseResponse(res: Response): Promise<JsonRpcResponse> {
    // Read the SSE stream line-by-line and look for a `data:` frame that
    // contains a JSON-RPC response.  We stop at the first such frame.
    const reader = res.body?.getReader();
    if (!reader) {
      throw new McpTransportError('SSE response has no body', 'protocol');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload && payload !== '[DONE]') {
              try {
                return this.parseJsonResponse(payload);
              } catch {
                // Not a JSON-RPC response — skip this frame
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    throw new McpTransportError('SSE stream ended without a JSON-RPC response', 'protocol');
  }

  private parseJsonResponse(text: string): JsonRpcResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new McpTransportError(
        `MCP response is not valid JSON: ${text.slice(0, 120)}`,
        'protocol',
        { cause: err },
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('jsonrpc' in parsed) ||
      (parsed as { jsonrpc: unknown }).jsonrpc !== '2.0'
    ) {
      throw new McpTransportError('MCP response is not a valid JSON-RPC 2.0 message', 'protocol');
    }

    return parsed as JsonRpcResponse;
  }
}
