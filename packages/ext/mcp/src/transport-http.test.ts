/**
 * HttpMcpTransport unit tests.
 * All fetch calls are mocked — no real network.
 */

import { describe, expect, it, vi } from 'vitest';

import { HttpMcpTransport } from './transport-http.js';
import { McpTransportError } from './types.js';

function makeJsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'content-type') return 'application/json';
        const key = Object.keys(extraHeaders).find((k) => k.toLowerCase() === lower);
        return key !== undefined ? (extraHeaders[key] ?? null) : null;
      },
    },
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response;
}

function makeRequest(id = 1) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/list',
  };
}

describe('HttpMcpTransport', () => {
  it('sends a POST with correct headers and returns parsed JSON-RPC response', async () => {
    const expected = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
    const fetchFn = vi.fn().mockResolvedValue(makeJsonResponse(expected));

    const transport = new HttpMcpTransport({
      url: 'https://mcp.example.com/mcp',
      fetchFn,
    });

    const res = await transport.request(makeRequest());

    expect(res).toEqual(expected);
    expect(fetchFn).toHaveBeenCalledOnce();

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mcp.example.com/mcp');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('merges custom headers', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));

    const transport = new HttpMcpTransport({
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Workspace': 'acme' },
      fetchFn,
    });

    await transport.request(makeRequest());

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Workspace']).toBe('acme');
  });

  it('throws McpTransportError on non-OK HTTP status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeJsonResponse({}, 503));

    const transport = new HttpMcpTransport({
      url: 'https://mcp.example.com/mcp',
      fetchFn,
    });

    await expect(transport.request(makeRequest())).rejects.toThrowError(McpTransportError);
  });

  it('throws McpTransportError on invalid JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => 'not-json',
      body: null,
    } as unknown as Response);

    const transport = new HttpMcpTransport({
      url: 'https://mcp.example.com/mcp',
      fetchFn,
    });

    await expect(transport.request(makeRequest())).rejects.toThrowError(McpTransportError);
  });

  it('throws McpTransportError when closed', async () => {
    const fetchFn = vi.fn();
    const transport = new HttpMcpTransport({
      url: 'https://mcp.example.com/mcp',
      fetchFn,
    });

    await transport.close();

    await expect(transport.request(makeRequest())).rejects.toThrowError(McpTransportError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe('Mcp-Session-Id session continuity', () => {
    it('captures Mcp-Session-Id from response and echoes it on subsequent requests', async () => {
      const expected = { jsonrpc: '2.0', id: 1, result: {} };
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(makeJsonResponse(expected, 200, { 'mcp-session-id': 'sess_abc123' }))
        .mockResolvedValueOnce(makeJsonResponse(expected));

      const transport = new HttpMcpTransport({
        url: 'https://mcp.example.com/mcp',
        fetchFn,
      });

      // First request — server returns Mcp-Session-Id.
      await transport.request(makeRequest(1));

      // Second request — transport must echo the captured session-id.
      await transport.request(makeRequest(2));

      expect(fetchFn).toHaveBeenCalledTimes(2);
      const [, secondInit] = fetchFn.mock.calls[1] as [string, RequestInit];
      expect((secondInit.headers as Record<string, string>)['Mcp-Session-Id']).toBe('sess_abc123');
    });

    it('does not send Mcp-Session-Id header when the server never set one', async () => {
      const expected = { jsonrpc: '2.0', id: 1, result: {} };
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(makeJsonResponse(expected))
        .mockResolvedValueOnce(makeJsonResponse(expected));

      const transport = new HttpMcpTransport({
        url: 'https://mcp.example.com/mcp',
        fetchFn,
      });

      await transport.request(makeRequest(1));
      await transport.request(makeRequest(2));

      const [, secondInit] = fetchFn.mock.calls[1] as [string, RequestInit];
      expect((secondInit.headers as Record<string, string>)['Mcp-Session-Id']).toBeUndefined();
    });

    it('does not send Mcp-Session-Id on the first request', async () => {
      const expected = { jsonrpc: '2.0', id: 1, result: {} };
      const fetchFn = vi.fn().mockResolvedValue(makeJsonResponse(expected));

      const transport = new HttpMcpTransport({
        url: 'https://mcp.example.com/mcp',
        fetchFn,
      });

      await transport.request(makeRequest(1));

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Mcp-Session-Id']).toBeUndefined();
    });
  });

  it('parses SSE response correctly', async () => {
    const rpcResponse = { jsonrpc: '2.0', id: 1, result: { tools: ['a'] } };
    const sseBody = `data: ${JSON.stringify(rpcResponse)}\n\n`;

    const chunks = [new TextEncoder().encode(sseBody)];
    let chunkIndex = 0;

    const mockReader = {
      read: vi.fn().mockImplementation(async () => {
        if (chunkIndex < chunks.length) {
          const value = chunks[chunkIndex];
          chunkIndex++;
          return { done: false, value };
        }
        return { done: true, value: undefined };
      }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => mockReader },
    } as unknown as Response;

    const fetchFn = vi.fn().mockResolvedValue(mockResponse);

    const transport = new HttpMcpTransport({
      url: 'https://mcp.example.com/mcp',
      fetchFn,
    });

    const res = await transport.request(makeRequest());
    expect(res).toEqual(rpcResponse);
  });
});
