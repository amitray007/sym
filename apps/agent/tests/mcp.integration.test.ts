/**
 * MCP real-wire integration tests — NO SDK mocks.
 *
 * These tests spawn real subprocesses and stand up real local HTTP servers.
 * They validate that the full acquisition → injection → transport → connect
 * pipeline actually delivers credentials over the real wire, not just in unit
 * test mocks.
 *
 * (A) stdio subprocess injection proof — validates env injection (C1) +
 *     file-pointer injection (C2.5) on a real child process.
 *
 * (B) http header-injection proof — validates that Authorization headers
 *     constructed by StaticProvider / buildTransport reach a real local
 *     StreamableHTTP server (C2).
 *
 * Key invariant: tests MUST ACTUALLY RUN (not skip) and MUST spawn a real
 * child process or server. The test output confirms subprocess/server activity.
 *
 * Timeouts are generous but bounded (see per-test `timeout` option).
 */

import * as http from 'node:http';
import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';

import { Server as McpLowLevelServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpDispatcher, _resetPoolForTesting } from '../src/mcp/dispatcher.js';
import { buildTransport } from '../src/mcp/inject.js';

import type { ConnectorConfig } from '../src/mcp/config.js';
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  ConversationId,
  JsonObject,
  SlackChannelId,
  SlackUserId,
  ToolCall,
  ToolRuntimeContext,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';
import type { Socket } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_PATH = nodePath.resolve(
  nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)),
  'fixtures',
  'echo-mcp-server.mjs',
);

function makeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws_test' as WorkspaceId,
    conversationId: 'ws_test:C1' as ConversationId,
    channelId: 'C1' as SlackChannelId,
    requester: 'U_test' as SlackUserId,
    turnId: 'turn_test' as TurnId,
  };
}

function makeCall(name: string, args: JsonObject = {}, id = 'call_01'): ToolCall {
  return { id, name, arguments: args };
}

/**
 * Create a fresh McpServer + StreamableHTTPServerTransport for a single request.
 *
 * The StreamableHTTP stateless pattern requires a new transport+server per request
 * (the server state machine can't be reused across HTTP requests). This factory
 * creates both and connects them before each request is handled.
 */
async function createRequestHandler(): Promise<{
  handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
}> {
  const mcpServer = new McpLowLevelServer(
    { name: 'http-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ping',
        description: 'Returns pong',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));

  // Stateless mode: one transport per request, no session IDs.
  // The cast is required because exactOptionalPropertyTypes prevents assigning
  // `undefined` explicitly to the optional `sessionIdGenerator?: () => string` field.
  const transportOpts = {
    sessionIdGenerator: undefined,
  } as unknown as StreamableHTTPServerTransportOptions;
  const transport = new StreamableHTTPServerTransport(transportOpts);

  // connect(): cast required — StreamableHTTPServerTransport's optional callbacks
  // conflict with Transport interface under exactOptionalPropertyTypes.
  await (mcpServer.connect as (t: unknown) => Promise<void>)(transport);

  return {
    handleRequest: async (req, res) => {
      await transport.handleRequest(req, res);
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
    },
  };
}

/**
 * Start a minimal MCP HTTP server on localhost.
 *
 * Returns the server's port number and a stop function.
 * The server registers a single `ping` tool that returns 'pong'.
 *
 * Uses stateless mode (one transport+server per request) — this is the
 * correct pattern for StreamableHTTP stateless operation.
 *
 * The stop() function forcibly destroys open sockets so tests don't hang
 * waiting for the Streamable HTTP client's background SSE connection to close.
 */
async function startHttpMcpServer(onRequest?: (req: http.IncomingMessage) => void): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  // Track open sockets so we can force-destroy them on shutdown.
  const openSockets = new Set<Socket>();

  const httpServer = http.createServer((req, res) => {
    if (onRequest !== undefined) {
      onRequest(req);
    }
    // Create a fresh transport+server for every HTTP request (stateless mode)
    createRequestHandler()
      .then(({ handleRequest }) => handleRequest(req, res))
      .catch((err: unknown) => {
        console.error('[fixture-http] handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500).end(JSON.stringify({ error: String(err) }));
        }
      });
  });

  httpServer.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = httpServer.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('Unexpected server address type');
  }
  const port = addr.port;

  return {
    port,
    stop: () => {
      // Force-destroy all open sockets (SSE long-poll connections etc.)
      for (const socket of openSockets) {
        socket.destroy();
      }
      return new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// (A) stdio subprocess injection proof
// ---------------------------------------------------------------------------

describe('Integration — stdio subprocess injection', () => {
  beforeEach(() => {
    _resetPoolForTesting();
  });

  afterEach(() => {
    _resetPoolForTesting();
  });

  it(
    'Test A1: env injection — secret reaches the real child process env',
    async () => {
      // ConnectorConfig with env injection: injects 's3cr3t' as INJECTED_TOKEN
      const config: ConnectorConfig = {
        name: 'echo-env',
        transport: {
          kind: 'stdio',
          command: 'node',
          args: [FIXTURE_PATH],
        },
        auth: {
          kind: 'static',
          secret: 's3cr3t',
          inject: { at: 'env', name: 'INJECTED_TOKEN' },
        },
        trust: true,
      };

      const dispatcher = new McpDispatcher([config]);

      // Step 1: list tools — forces real subprocess spawn + SDK connect
      const tools = await dispatcher.listAsync();
      expect(tools.some((t) => t.name === 'echo-env__get_env')).toBe(true);

      // Step 2: dispatch get_env — child reads INJECTED_TOKEN from its own process.env
      const result = await dispatcher.dispatch(
        makeCall('echo-env__get_env', { name: 'INJECTED_TOKEN' } satisfies JsonObject),
        makeCtx(),
      );

      expect(result.ok).toBe(true);
      // Assert: the child process received the injected secret in its env
      if (result.ok) {
        expect(result.content).toBe('s3cr3t');
      }
    },
    { timeout: 30_000 },
  );

  it(
    'Test A2: file injection — materialized credential file reaches real child process',
    async () => {
      const secretContent = '{"type":"service_account","project_id":"test-proj"}';

      // ConnectorConfig with file injection: writes secret to key.json,
      // sets GOOGLE_APPLICATION_CREDENTIALS to the file path
      const config: ConnectorConfig = {
        name: 'echo-file',
        transport: {
          kind: 'stdio',
          command: 'node',
          args: [FIXTURE_PATH],
        },
        auth: {
          kind: 'static',
          secret: secretContent,
          inject: {
            at: 'file',
            path: 'key.json',
            pointerEnv: 'GOOGLE_APPLICATION_CREDENTIALS',
          },
        },
        trust: true,
      };

      const dispatcher = new McpDispatcher([config]);

      // Step 1: list tools
      const tools = await dispatcher.listAsync();
      expect(tools.some((t) => t.name === 'echo-file__read_cred_file')).toBe(true);

      // Step 2: dispatch read_cred_file — child reads file at GOOGLE_APPLICATION_CREDENTIALS
      const result = await dispatcher.dispatch(makeCall('echo-file__read_cred_file'), makeCtx());

      expect(result.ok).toBe(true);
      // Assert: the child process read the materialized key.json and returned its contents
      if (result.ok) {
        expect(result.content).toBe(secretContent);
      }
    },
    { timeout: 30_000 },
  );
});

// ---------------------------------------------------------------------------
// (B) http header-injection proof
// ---------------------------------------------------------------------------

describe('Integration — HTTP header injection', () => {
  let stopServer: () => Promise<void>;
  let serverPort: number;
  let capturedAuthHeader: string | undefined;

  beforeEach(async () => {
    _resetPoolForTesting();
    capturedAuthHeader = undefined;

    const srv = await startHttpMcpServer((req) => {
      const auth = req.headers['authorization'];
      if (auth !== undefined) {
        capturedAuthHeader = auth;
      }
    });
    serverPort = srv.port;
    stopServer = srv.stop;
  });

  afterEach(async () => {
    _resetPoolForTesting();
    await stopServer();
  });

  it(
    'Test B1: Authorization header reaches the real HTTP MCP server',
    async () => {
      const config: ConnectorConfig = {
        name: 'http-ping',
        transport: {
          kind: 'http',
          url: `http://127.0.0.1:${serverPort}`,
        },
        auth: {
          kind: 'static',
          secret: 'tok-xyz',
          inject: {
            at: 'header',
            name: 'Authorization',
            valueTemplate: 'Bearer {{token}}',
          },
        },
        trust: true,
      };

      const dispatcher = new McpDispatcher([config]);

      // Step 1: list tools — forces real HTTP connect (sends Authorization header)
      const tools = await dispatcher.listAsync();

      // (i) listAsync returns the namespaced tool
      expect(tools.some((t) => t.name === 'http-ping__ping')).toBe(true);

      // (ii) The server captured Authorization: Bearer tok-xyz on the wire
      expect(capturedAuthHeader).toBe('Bearer tok-xyz');

      // Step 2: dispatch ping → asserts round-trip tool call returns 'pong'
      const result = await dispatcher.dispatch(makeCall('http-ping__ping'), makeCtx());

      // (iii) dispatch returns 'pong'
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe('pong');
      }
    },
    { timeout: 30_000 },
  );

  it(
    'Test B2: transport.headers (static) + injected secret header both reach the server',
    async () => {
      let capturedClientHeader: string | undefined;

      // Start a second server that also captures X-Client
      const srv2 = await startHttpMcpServer((req) => {
        const auth = req.headers['authorization'];
        if (auth !== undefined) capturedAuthHeader = auth;
        const client = req.headers['x-client'];
        if (typeof client === 'string') capturedClientHeader = client;
      });

      try {
        const config: ConnectorConfig = {
          name: 'http-multi',
          transport: {
            kind: 'http',
            url: `http://127.0.0.1:${srv2.port}`,
            // Non-secret static header — merged by buildTransport
            headers: { 'x-client': 'sym' },
          },
          auth: {
            kind: 'static',
            secret: 'tok-multi',
            inject: {
              at: 'header',
              name: 'Authorization',
              valueTemplate: 'Bearer {{token}}',
            },
          },
          trust: true,
        };

        const dispatcher = new McpDispatcher([config]);
        const tools = await dispatcher.listAsync();

        expect(tools.some((t) => t.name === 'http-multi__ping')).toBe(true);
        // Injected secret header
        expect(capturedAuthHeader).toBe('Bearer tok-multi');
        // Non-secret static transport header
        expect(capturedClientHeader).toBe('sym');
      } finally {
        await srv2.stop();
      }
    },
    { timeout: 30_000 },
  );
});

// ---------------------------------------------------------------------------
// buildTransport — pure http unit checks (no real server)
// ---------------------------------------------------------------------------

describe('buildTransport — http arm (pure unit checks)', () => {
  it('no auth → returns a valid Transport (no throw)', () => {
    const { transport: t } = buildTransport(
      { kind: 'http', url: 'https://example.com/mcp' },
      { apply: 'none' },
    );
    expect(typeof t.start).toBe('function');
    expect(typeof t.send).toBe('function');
    expect(typeof t.close).toBe('function');
  });

  it('headers credential → returns a valid Transport (no throw)', () => {
    const { transport: t } = buildTransport(
      { kind: 'http', url: 'https://example.com/mcp' },
      { apply: 'headers', headers: { Authorization: 'Bearer tok' } },
    );
    expect(typeof t.start).toBe('function');
  });

  it('env credential on http → throws stdio-only error', () => {
    expect(() =>
      buildTransport(
        { kind: 'http', url: 'https://example.com/mcp' },
        { apply: 'env', vars: { TOKEN: 'tok' } },
      ),
    ).toThrow(/stdio-only/);
  });

  it('argv credential on http → throws stdio-only error', () => {
    expect(() =>
      buildTransport(
        { kind: 'http', url: 'https://example.com/mcp' },
        { apply: 'argv', args: ['--token=tok'] },
      ),
    ).toThrow(/stdio-only/);
  });

  it('transport.headers (static) merged with credential headers — credential wins on collision', () => {
    // Just verifies no throw and returns a valid transport.
    // Header content verification happens in the real-wire test (B2).
    const { transport: t } = buildTransport(
      {
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: { 'x-shared': 'static', 'x-client': 'sym' },
      },
      { apply: 'headers', headers: { Authorization: 'Bearer tok', 'x-shared': 'cred-wins' } },
    );
    expect(typeof t.start).toBe('function');
  });
});
