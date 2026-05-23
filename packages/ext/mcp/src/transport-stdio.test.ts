/**
 * StdioMcpTransport unit tests.
 * Uses a mock child process — no real spawning.
 */

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { StdioMcpTransport } from './transport-stdio.js';
import { McpTransportError } from './types.js';

// ---------------------------------------------------------------------------
// Mock child process factory
// ---------------------------------------------------------------------------

interface MockProcess extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; writable: boolean };
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  /** Send a framed JSON-RPC response back to the transport. */
  sendResponse(body: unknown): void;
}

function makeMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;

  const stdinEmitter = new EventEmitter();
  proc.stdin = Object.assign(stdinEmitter, {
    write: vi.fn(),
    end: vi.fn(),
    writable: true,
  });

  const stdoutEmitter = new EventEmitter();
  proc.stdout = Object.assign(stdoutEmitter, {
    setEncoding: vi.fn(),
  });

  const stderrEmitter = new EventEmitter();
  proc.stderr = Object.assign(stderrEmitter, {
    setEncoding: vi.fn(),
  });

  proc.kill = vi.fn();

  proc.sendResponse = (body: unknown) => {
    const json = JSON.stringify(body);
    const frame = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    proc.stdout.emit('data', frame);
  };

  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StdioMcpTransport', () => {
  it('frames outgoing requests with Content-Length and returns parsed response', async () => {
    const mockProc = makeMockProcess();
    const spawnFn = vi.fn().mockReturnValue(mockProc);

    const transport = new StdioMcpTransport({
      command: 'my-mcp-server',
      spawnFn: spawnFn as unknown as StdioTransportOptions['spawnFn'],
    });

    const req = { jsonrpc: '2.0' as const, id: 42, method: 'tools/list' };

    // Send the response after a tick.
    const responsePayload = { jsonrpc: '2.0', id: 42, result: { tools: [] } };
    setImmediate(() => mockProc.sendResponse(responsePayload));

    const res = await transport.request(req);
    expect(res).toEqual(responsePayload);

    // The stdin.write should have been called with a proper Content-Length frame.
    const written: string = mockProc.stdin.write.mock.calls[0]?.[0] as string;
    expect(written).toMatch(/^Content-Length: \d+\r\n\r\n/);
    expect(written).toContain('"method":"tools/list"');
  });

  it('rejects with McpTransportError when the process exits unexpectedly', async () => {
    const mockProc = makeMockProcess();
    const spawnFn = vi.fn().mockReturnValue(mockProc);

    const transport = new StdioMcpTransport({
      command: 'my-mcp-server',
      spawnFn: spawnFn as unknown as StdioTransportOptions['spawnFn'],
    });

    const req = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
    const requestPromise = transport.request(req);

    // Simulate unexpected process exit.
    setImmediate(() => mockProc.emit('close'));

    await expect(requestPromise).rejects.toThrowError(McpTransportError);
  });

  it('handles multiple framed responses in one chunk', async () => {
    const mockProc = makeMockProcess();
    const spawnFn = vi.fn().mockReturnValue(mockProc);

    const transport = new StdioMcpTransport({
      command: 'my-mcp-server',
      spawnFn: spawnFn as unknown as StdioTransportOptions['spawnFn'],
    });

    const req1 = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
    const req2 = { jsonrpc: '2.0' as const, id: 2, method: 'tools/list' };

    const r1 = { jsonrpc: '2.0', id: 1, result: { tools: ['a'] } };
    const r2 = { jsonrpc: '2.0', id: 2, result: { tools: ['b'] } };

    const p1 = transport.request(req1);
    const p2 = transport.request(req2);

    setImmediate(() => {
      // Send both responses in one chunk.
      const body1 = JSON.stringify(r1);
      const body2 = JSON.stringify(r2);
      const frame =
        `Content-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}` +
        `Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`;
      mockProc.stdout.emit('data', frame);
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toEqual(r1);
    expect(res2).toEqual(r2);
  });

  it('throws McpTransportError when transport is closed', async () => {
    const mockProc = makeMockProcess();
    const spawnFn = vi.fn().mockReturnValue(mockProc);

    const transport = new StdioMcpTransport({
      command: 'my-mcp-server',
      spawnFn: spawnFn as unknown as StdioTransportOptions['spawnFn'],
    });

    await transport.close();

    const req = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
    await expect(transport.request(req)).rejects.toThrowError(McpTransportError);
  });
});

// Re-export for the type
type StdioTransportOptions = ConstructorParameters<typeof StdioMcpTransport>[0];
