/**
 * MCP stdio transport — spawn a child process, framed messages with
 * `Content-Length` headers, EOF handling.
 *
 * Wire format (LSP-style):
 *   Content-Length: <n>\r\n
 *   \r\n
 *   <n bytes of JSON>
 *
 * Each outbound request writes one such frame to the child's stdin.
 * Inbound responses are read from stdout.
 * Stderr is collected and logged on close (never sent to the MCP client).
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

import { McpTransportError } from './types.js';

import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse, McpTransport } from './types.js';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Timeout (ms) for a single request (default: 30_000). */
  timeoutMs?: number;
  /**
   * Injectable factory for spawning the child process.
   * Defaults to Node's `child_process.spawn`.
   * Override in tests to avoid real process spawning.
   */
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

interface PendingCall {
  resolve: (r: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const HEADER_SEP = '\r\n\r\n';
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;

export class StdioMcpTransport implements McpTransport {
  private readonly process: ChildProcess;
  private readonly timeoutMs: number;

  /** Pending in-flight requests, keyed by JSON-RPC id. */
  private readonly pending = new Map<string, PendingCall>();

  /** Accumulated stdout bytes awaiting framing. */
  private readBuf = '';

  private closed = false;
  private stderrBuf = '';

  constructor(opts: StdioTransportOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const spawnFn = opts.spawnFn ?? spawn;
    this.process = spawnFn(opts.command, opts.args ?? [], {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.setEncoding('utf8');
    this.process.stderr?.setEncoding('utf8');

    this.process.stdout?.on('data', (chunk: string) => {
      this.readBuf += chunk;
      this.drainBuffer();
    });

    this.process.stderr?.on('data', (chunk: string) => {
      this.stderrBuf += chunk;
    });

    this.process.on('close', () => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new McpTransportError('MCP stdio process exited', 'closed'));
      }
      this.pending.clear();
    });

    this.process.on('error', (err) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          new McpTransportError(`MCP stdio process error: ${err.message}`, 'network', {
            cause: err,
          }),
        );
      }
      this.pending.clear();
    });
  }

  async request(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw new McpTransportError('Transport is closed', 'closed');
    }

    const key = pendingKey(req.id);

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new McpTransportError('MCP stdio request timed out', 'timeout'));
      }, this.timeoutMs);

      this.pending.set(key, { resolve, reject, timer });

      const body = JSON.stringify(req);
      const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;

      if (!this.process.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new McpTransportError('MCP stdio stdin is not writable', 'closed'));
        return;
      }

      this.process.stdin.write(frame, 'utf8');
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.stdin?.end();
    // Give the process a moment to flush, then kill it.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.process.kill();
        resolve();
      }, 2_000);
      this.process.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Private — buffer draining
  // ---------------------------------------------------------------------------

  private drainBuffer(): void {
    while (true) {
      const sepIdx = this.readBuf.indexOf(HEADER_SEP);
      if (sepIdx === -1) break;

      const headerSection = this.readBuf.slice(0, sepIdx);
      const match = CONTENT_LENGTH_RE.exec(headerSection);
      if (!match) {
        // Malformed frame — drop everything up to and including the separator.
        this.readBuf = this.readBuf.slice(sepIdx + HEADER_SEP.length);
        continue;
      }

      const contentLength = parseInt(match[1] ?? '0', 10);
      const bodyStart = sepIdx + HEADER_SEP.length;

      // Wait for the full body to arrive.
      if (this.readBuf.length - bodyStart < contentLength) break;

      const body = this.readBuf.slice(bodyStart, bodyStart + contentLength);
      this.readBuf = this.readBuf.slice(bodyStart + contentLength);

      this.dispatchFrame(body);
    }
  }

  private dispatchFrame(body: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Unparseable frame — ignore.
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) return;

    const id = (parsed as { id: JsonRpcId }).id;
    const key = pendingKey(id);
    const pending = this.pending.get(key);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve(parsed as JsonRpcResponse);
  }
}

function pendingKey(id: JsonRpcId): string {
  return id === null ? 'null' : String(id);
}
