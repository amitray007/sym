/**
 * Tests for the MCP client module — ConnectorConfig base refactor.
 *
 * Covers:
 *  1.  Config parsing (valid/invalid/empty SYM_MCP_SERVERS values)
 *  2.  StaticProvider.resolve — string secret, record secret, argv, array
 *  3.  buildTransport — env merge order, argv append, stub arms
 *  4.  makeProvider — static→StaticProvider, oauth→OAuthProvider (C3), undefined→null
 *  5.  CompositeDispatcher prefix routing
 *  6.  McpDispatcher — MCP result → ToolResult mapping + security annotations
 *  7.  FAIL OPEN — down server → zero tools, no throw
 *  8.  Connect TIMEOUT — hanging server fails open within bound
 *
 * MCP Client/Transport are fully mocked — no real subprocess is spawned.
 */

// vi.mock() calls are hoisted to the top of the file by the vitest transform,
// so they execute before any imports regardless of where they appear in source.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return { Client: vi.fn() };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation(function (opts: unknown) {
      return { _opts: opts };
    }),
  };
});

import * as fsPromises from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { Client as MockClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as MockStdioTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CompositeDispatcher,
  parseMcpServers,
  McpDispatcher,
  MCP_TOOL_SEPARATOR,
  _resetPoolForTesting,
  initMcpPool,
  parseConnectTimeoutMs,
  buildTransport,
  Materializer,
  _getActiveDirsForTesting,
  makeProvider,
  NotImplementedError,
  StaticProvider,
} from '@sym/mcp-runtime';

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  ConversationId,
  JsonObject,
  SlackChannelId,
  SlackUserId,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';
import type { ConnectorConfig, Injection, SecretMaterial } from '@sym/mcp-runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws_01' as WorkspaceId,
    conversationId: 'ws_01:C1' as ConversationId,
    channelId: 'C1' as SlackChannelId,
    requester: 'U_alice' as SlackUserId,
    turnId: 'turn_01' as TurnId,
  };
}

function makeCall(name: string, args: JsonObject = {}, id = 'call_01'): ToolCall {
  return { id, name, arguments: args };
}

/** Minimal ToolDispatcher stub for testing CompositeDispatcher routing. */
function makeStubDispatcher(
  toolNames: string[],
  dispatchResult: (name: string) => ToolResult,
): ToolDispatcher {
  return {
    list(): ToolDescriptor[] {
      return toolNames.map((name) => ({
        type: 'function' as const,
        name,
        description: `stub ${name}`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }));
    },
    dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> {
      return Promise.resolve(dispatchResult(call.name));
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Config parsing
// ---------------------------------------------------------------------------

describe('parseMcpServers', () => {
  it('returns empty array when env var is undefined', () => {
    expect(parseMcpServers(undefined)).toEqual([]);
  });

  it('returns empty array when env var is empty string', () => {
    expect(parseMcpServers('')).toEqual([]);
  });

  it('returns empty array when env var is whitespace', () => {
    expect(parseMcpServers('   ')).toEqual([]);
  });

  it('returns empty array and logs on invalid JSON', () => {
    const result = parseMcpServers('not json {{}');
    expect(result).toEqual([]);
  });

  it('returns empty array and logs when JSON is not an array', () => {
    const result = parseMcpServers('{"name":"x"}');
    expect(result).toEqual([]);
  });

  // --- New nested shape ---

  it('parses a minimal stdio connector (new nested shape)', () => {
    const raw = JSON.stringify([
      { name: 'my-server', transport: { kind: 'stdio', command: '/usr/bin/server' } },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'my-server',
      transport: { kind: 'stdio', command: '/usr/bin/server' },
    });
  });

  it('parses a stdio connector with args and env in transport', () => {
    const raw = JSON.stringify([
      {
        name: 'full',
        transport: {
          kind: 'stdio',
          command: '/bin/full',
          args: ['--port', '9000'],
          env: { X: '1' },
        },
        trust: true,
      },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    const cfg = result[0]!;
    expect(cfg.transport).toMatchObject({
      kind: 'stdio',
      command: '/bin/full',
      args: ['--port', '9000'],
      env: { X: '1' },
    });
    expect(cfg.trust).toBe(true);
  });

  it('parses a stdio connector with static env auth', () => {
    const raw = JSON.stringify([
      {
        name: 'authed',
        transport: { kind: 'stdio', command: '/bin/srv' },
        auth: { kind: 'static', secret: 'tok-abc', inject: { at: 'env', name: 'API_KEY' } },
      },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    const cfg = result[0]!;
    expect(cfg.auth).toMatchObject({
      kind: 'static',
      secret: 'tok-abc',
      inject: { at: 'env', name: 'API_KEY' },
    });
  });

  it('parses a stdio connector without auth', () => {
    const raw = JSON.stringify([
      { name: 'no-auth', transport: { kind: 'stdio', command: '/bin/x' } },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.auth).toBeUndefined();
  });

  it('parses a record-secret static auth with two inject targets', () => {
    const raw = JSON.stringify([
      {
        name: 'basic-auth',
        transport: { kind: 'stdio', command: '/bin/srv' },
        auth: {
          kind: 'static',
          secret: { user: 'alice', pass: 'hunter2' },
          inject: [
            { at: 'env', name: 'BASIC_USER', field: 'user' },
            { at: 'env', name: 'BASIC_PASS', field: 'pass' },
          ],
        },
      },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    const cfg = result[0]!;
    expect(cfg.auth).toMatchObject({
      kind: 'static',
      secret: { user: 'alice', pass: 'hunter2' },
    });
    expect(Array.isArray((cfg.auth as { inject: unknown }).inject)).toBe(true);
  });

  it('accepts http transport (C2 implemented — parses as first-class)', () => {
    const raw = JSON.stringify([
      { name: 'remote', transport: { kind: 'http', url: 'https://example.com/mcp' } },
    ]);
    const result = parseMcpServers(raw);
    // http is accepted at parse time (fail-open at connect); entry is included
    expect(result).toHaveLength(1);
    expect(result[0]?.transport).toMatchObject({
      kind: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('accepts oauth auth structurally (C3 stub — logs info)', () => {
    const raw = JSON.stringify([
      {
        name: 'oauth-srv',
        transport: { kind: 'stdio', command: '/bin/srv' },
        auth: { kind: 'oauth' },
      },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.auth).toMatchObject({ kind: 'oauth' });
  });

  it('accepts ambient auth (CLI self-authenticates from disk)', () => {
    const raw = JSON.stringify([
      {
        name: 'gcloud',
        transport: {
          kind: 'stdio',
          command: 'gcloud-mcp',
          env: { CLOUDSDK_CONFIG: '/data/gcloud' },
        },
        auth: { kind: 'ambient' },
      },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.auth).toEqual({ kind: 'ambient' });
    expect(result[0]?.transport).toMatchObject({ env: { CLOUDSDK_CONFIG: '/data/gcloud' } });
  });

  it('skips entries missing required name', () => {
    const raw = JSON.stringify([{ transport: { kind: 'stdio', command: '/bin/server' } }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries missing required command (new shape)', () => {
    const raw = JSON.stringify([{ name: 'x', transport: { kind: 'stdio' } }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries missing transport entirely', () => {
    const raw = JSON.stringify([{ name: 'x' }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries where transport.args is not an array of strings', () => {
    const raw = JSON.stringify([
      { name: 'x', transport: { kind: 'stdio', command: '/bin/x', args: [1, 2] } },
    ]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries where transport.env is not a string record', () => {
    const raw = JSON.stringify([
      { name: 'x', transport: { kind: 'stdio', command: '/bin/x', env: { k: 42 } } },
    ]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries where trust is not boolean', () => {
    const raw = JSON.stringify([
      { name: 'x', transport: { kind: 'stdio', command: '/bin/x' }, trust: 'yes' },
    ]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips invalid entries while keeping valid ones (per-entry fail-open)', () => {
    const raw = JSON.stringify([
      { name: 'good', transport: { kind: 'stdio', command: '/bin/good' } },
      { transport: { kind: 'stdio', command: '/bin/no-name' } }, // missing name
      { name: 'also-good', transport: { kind: 'stdio', command: '/bin/also-good' } },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'good' });
    expect(result[1]).toMatchObject({ name: 'also-good' });
  });

  it('does not set trust when trust is false or absent', () => {
    const raw = JSON.stringify([
      { name: 'x', transport: { kind: 'stdio', command: '/bin/x' }, trust: false },
    ]);
    const result = parseMcpServers(raw);
    expect(result[0]).not.toHaveProperty('trust');
  });

  it('skips entries with unknown transport kind', () => {
    const raw = JSON.stringify([{ name: 'x', transport: { kind: 'websocket', url: 'ws://x' } }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. StaticProvider.resolve
// ---------------------------------------------------------------------------

describe('StaticProvider', () => {
  it('string secret → env: resolves to { apply: env, vars: { NAME: value } }', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: 'tok-abc',
      inject: { at: 'env', name: 'API_KEY' },
    });
    const cred = await provider.resolve();
    expect(cred).toEqual({ apply: 'env', vars: { API_KEY: 'tok-abc' } });
  });

  it('record secret → multiple env vars', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: { user: 'alice', pass: 'hunter2' },
      inject: [
        { at: 'env', name: 'BASIC_USER', field: 'user' },
        { at: 'env', name: 'BASIC_PASS', field: 'pass' },
      ],
    });
    const cred = await provider.resolve();
    expect(cred).toEqual({ apply: 'env', vars: { BASIC_USER: 'alice', BASIC_PASS: 'hunter2' } });
  });

  it('argv injection with {{token}} template', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: 'sk-12345',
      inject: { at: 'argv', template: '--api-key={{token}}' },
    });
    const cred = await provider.resolve();
    expect(cred).toEqual({ apply: 'argv', args: ['--api-key=sk-12345'] });
  });

  it('argv injection with {{secret}} alias', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: 'my-secret',
      inject: { at: 'argv', template: '{{secret}}' },
    });
    const cred = await provider.resolve();
    expect(cred).toEqual({ apply: 'argv', args: ['my-secret'] });
  });

  it('inject array with both env targets produces merged env', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: 'shared-token',
      inject: [
        { at: 'env', name: 'TOKEN_A' },
        { at: 'env', name: 'TOKEN_B' },
      ],
    });
    const cred = await provider.resolve();
    expect(cred).toEqual({
      apply: 'env',
      vars: { TOKEN_A: 'shared-token', TOKEN_B: 'shared-token' },
    });
  });

  it('mixing env + argv injections → throws (one-channel rule)', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: 'tok',
      inject: [
        { at: 'env', name: 'TOKEN' },
        { at: 'argv', template: '--token={{token}}' },
      ],
    });
    await expect(provider.resolve()).rejects.toThrow(/one channel/);
  });

  it('argv template with an unknown placeholder is left as-is (typo fails loud)', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: 'sk-12345',
      inject: { at: 'argv', template: '--key={{toklen}}' },
    });
    const cred = await provider.resolve();
    expect(cred).toEqual({ apply: 'argv', args: ['--key={{toklen}}'] });
  });

  it('secretRef only (no inline secret) → NotImplementedError', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secretRef: 'my-ref',
      inject: { at: 'env', name: 'X' },
    });
    await expect(provider.resolve()).rejects.toThrow(NotImplementedError);
    await expect(provider.resolve()).rejects.toThrow(/C2\.5/);
  });

  it('header injection → resolves to headers credential (C2 implemented)', async () => {
    const provider = new StaticProvider({
      kind: 'static',
      secret: 'tok',
      inject: { at: 'header', name: 'Authorization', valueTemplate: 'Bearer {{token}}' },
    });
    const cred = await provider.resolve();
    expect(cred).toEqual({ apply: 'headers', headers: { Authorization: 'Bearer tok' } });
  });

  it('file injection with string secret → resolves (implemented in C2.5)', async () => {
    // File injection is now implemented — no longer throws NotImplementedError.
    // We verify it resolves without throwing; full coverage is in the Materializer tests.
    const m = new Materializer(nodeOs.tmpdir());
    const provider = new StaticProvider(
      {
        kind: 'static',
        secret: '{"type":"service_account"}',
        inject: { at: 'file', path: 'key.json', pointerEnv: 'GOOGLE_APPLICATION_CREDENTIALS' },
      },
      m,
    );
    const cred = await provider.resolve();
    expect(cred.apply).toBe('files');
    if (cred.apply === 'files') {
      expect(typeof cred.dir).toBe('string');
      expect(cred.vars['GOOGLE_APPLICATION_CREDENTIALS']).toContain('key.json');
      // Clean up
      await fsPromises.rm(cred.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. buildTransport
// ---------------------------------------------------------------------------

describe('buildTransport', () => {
  beforeEach(() => {
    vi.mocked(MockStdioTransport).mockClear();
  });

  it('stdio + no auth → passes command through unchanged', () => {
    buildTransport({ kind: 'stdio', command: '/bin/srv' }, { apply: 'none' });
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith({
      command: '/bin/srv',
    });
  });

  it('stdio + env: transport.env first, then resolved.vars on top (credential wins on collision)', () => {
    buildTransport(
      { kind: 'stdio', command: '/bin/srv', env: { BASE: 'base', KEY: 'old' } },
      { apply: 'env', vars: { KEY: 'new', EXTRA: 'extra' } },
    );
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith({
      command: '/bin/srv',
      env: { BASE: 'base', KEY: 'new', EXTRA: 'extra' },
    });
  });

  it('stdio + env: only transport.env, no credential vars', () => {
    buildTransport({ kind: 'stdio', command: '/bin/srv', env: { X: '1' } }, { apply: 'none' });
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith({
      command: '/bin/srv',
      env: { X: '1' },
    });
  });

  it('stdio + argv: transport.args first, resolved.args appended', () => {
    buildTransport(
      { kind: 'stdio', command: '/bin/srv', args: ['--port', '9000'] },
      { apply: 'argv', args: ['--api-key=secret'] },
    );
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith({
      command: '/bin/srv',
      args: ['--port', '9000', '--api-key=secret'],
    });
  });

  it('stdio + argv: no base args, only resolved args', () => {
    buildTransport(
      { kind: 'stdio', command: '/bin/srv' },
      { apply: 'argv', args: ['--token=abc'] },
    );
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith({
      command: '/bin/srv',
      args: ['--token=abc'],
    });
  });

  it('http transport with no auth → builds StreamableHTTPClientTransport (C2 implemented)', () => {
    // Does not throw — C2 is implemented.
    expect(() =>
      buildTransport({ kind: 'http', url: 'https://x.example.com/mcp' }, { apply: 'none' }),
    ).not.toThrow();
  });

  it('http transport with headers credential → builds transport (C2 implemented)', () => {
    expect(() =>
      buildTransport(
        { kind: 'http', url: 'https://x.example.com/mcp' },
        { apply: 'headers', headers: { Authorization: 'Bearer tok' } },
      ),
    ).not.toThrow();
  });

  it('http transport with stdio-only credential (env) → throws clear error', () => {
    expect(() =>
      buildTransport(
        { kind: 'http', url: 'https://x.example.com/mcp' },
        { apply: 'env', vars: { TOKEN: 'tok' } },
      ),
    ).toThrow(/stdio-only/);
  });

  it('headers credential on stdio transport → throws clear error (not NotImplementedError)', () => {
    expect(() =>
      buildTransport(
        { kind: 'stdio', command: '/bin/srv' },
        { apply: 'headers', headers: { Authorization: 'Bearer tok' } },
      ),
    ).toThrow(/http transport/);
    expect(() =>
      buildTransport(
        { kind: 'stdio', command: '/bin/srv' },
        { apply: 'headers', headers: { Authorization: 'Bearer tok' } },
      ),
    ).not.toThrow(NotImplementedError);
  });

  it('files credential on stdio → builds transport with merged vars (C2.5 implemented)', () => {
    // files credential is now implemented — buildTransport merges vars into env.
    buildTransport(
      { kind: 'stdio', command: '/bin/srv', env: { BASE: 'val' } },
      {
        apply: 'files',
        dir: '/tmp/mcp-dir',
        vars: { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/mcp-dir/key.json' },
      },
    );
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/srv',
        env: { BASE: 'val', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/mcp-dir/key.json' },
      }),
    );
  });

  it('native credential on stdio → throws (OAuth not supported over stdio)', () => {
    expect(() =>
      buildTransport(
        { kind: 'stdio', command: '/bin/srv' },
        // Cast a stub as OAuthClientProvider — the value is never read because
        // the function throws before it reaches the native branch for stdio.
        { apply: 'native', oauth: {} as unknown as OAuthClientProvider },
      ),
    ).toThrow(/OAuth.*stdio/i);
  });
});

// ---------------------------------------------------------------------------
// 4. makeProvider
// ---------------------------------------------------------------------------

describe('makeProvider', () => {
  it('undefined auth → null (no provider)', () => {
    expect(makeProvider(undefined)).toBeNull();
  });

  it('ambient auth → null (ambient injects no credential)', () => {
    expect(makeProvider({ kind: 'ambient' })).toBeNull();
  });

  it('static auth → StaticProvider instance', () => {
    const provider = makeProvider({
      kind: 'static',
      secret: 'tok',
      inject: { at: 'env', name: 'X' },
    });
    expect(provider).toBeInstanceOf(StaticProvider);
  });

  it('oauth auth → OAuthProvider (C3 implemented)', () => {
    // C3 is now implemented — makeProvider returns an OAuthProvider (not null, not throw).
    // SYM_ENCRYPTION_KEY is required by the store; mock it for this unit test.
    const origKey = process.env['SYM_ENCRYPTION_KEY'];
    process.env['SYM_ENCRYPTION_KEY'] = Buffer.alloc(32).toString('base64');
    try {
      const provider = makeProvider({ kind: 'oauth' });
      expect(provider).not.toBeNull();
      expect(typeof provider?.resolve).toBe('function');
    } finally {
      if (origKey === undefined) {
        delete process.env['SYM_ENCRYPTION_KEY'];
      } else {
        process.env['SYM_ENCRYPTION_KEY'] = origKey;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. CompositeDispatcher routing
// ---------------------------------------------------------------------------

describe('CompositeDispatcher', () => {
  const builtinResult: ToolResult = {
    callId: 'call_01',
    ok: true,
    content: 'builtin result',
  };
  const mcpResult: ToolResult = {
    callId: 'call_01',
    ok: true,
    content: 'mcp result',
  };

  const builtin = makeStubDispatcher(['get_current_time', 'read_channel'], () => builtinResult);
  const mcp = makeStubDispatcher([`my-server${MCP_TOOL_SEPARATOR}do_thing`], () => mcpResult);
  const composite = new CompositeDispatcher(builtin, mcp);

  it('list() returns builtin tools first, then MCP tools', () => {
    const tools = composite.list();
    expect(tools.map((t) => t.name)).toEqual([
      'get_current_time',
      'read_channel',
      `my-server${MCP_TOOL_SEPARATOR}do_thing`,
    ]);
  });

  it('routes builtin tool calls to the builtin dispatcher', async () => {
    const result = await composite.dispatch(makeCall('get_current_time'), makeCtx());
    expect(result).toBe(builtinResult);
  });

  it('routes MCP tool calls (containing __) to the MCP dispatcher', async () => {
    const result = await composite.dispatch(
      makeCall(`my-server${MCP_TOOL_SEPARATOR}do_thing`),
      makeCtx(),
    );
    expect(result).toBe(mcpResult);
  });

  it('routes an unknown builtin tool (no __) to the builtin dispatcher', async () => {
    const result = await composite.dispatch(makeCall('unknown_builtin'), makeCtx());
    expect(result).toBe(builtinResult);
  });
});

// ---------------------------------------------------------------------------
// 6. McpDispatcher — MCP result → ToolResult mapping + security annotations
// ---------------------------------------------------------------------------

/** Build a mock Client that returns the given tools and callTool results. */
function makeMockClient(
  tools: { name: string; description?: string; inputSchema?: object }[],
  callToolResult?: { content: unknown; isError?: boolean } | Error,
): InstanceType<typeof MockClient> {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockImplementation(() => {
      if (callToolResult instanceof Error) return Promise.reject(callToolResult);
      return Promise.resolve(callToolResult ?? { content: [], isError: false });
    }),
  };
  return client as unknown as InstanceType<typeof MockClient>;
}

function makeConnector(overrides: Partial<ConnectorConfig> & { name: string }): ConnectorConfig {
  return {
    transport: { kind: 'stdio', command: '/bin/srv' },
    ...overrides,
  };
}

describe('McpDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPoolForTesting();
  });

  it('list() returns namespaced tool descriptors for a healthy server', async () => {
    const mockClient = makeMockClient([
      {
        name: 'do_thing',
        description: 'does a thing',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({ name: 'srv' });
    const dispatcher = new McpDispatcher([config]);

    await initMcpPool([config]);

    const tools = dispatcher.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(`srv${MCP_TOOL_SEPARATOR}do_thing`);
    expect(tools[0]?.description).toBe('does a thing');
  });

  it('sets destructiveHint:true on MCP tools when trust is not set', async () => {
    const mockClient = makeMockClient([
      { name: 'do_thing', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({ name: 'srv2' });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const tools = dispatcher.list();
    expect(tools[0]?.destructiveHint).toBe(true);
  });

  it('does NOT set destructiveHint when trust:true is set', async () => {
    const mockClient = makeMockClient([
      { name: 'do_thing', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({ name: 'trusted', trust: true });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const tools = dispatcher.list();
    expect(tools[0]?.destructiveHint).toBeUndefined();
  });

  it('maps text content result to ToolSuccess', async () => {
    const mockClient = makeMockClient(
      [{ name: 'greet', inputSchema: { type: 'object', properties: {} } }],
      { content: [{ type: 'text', text: 'Hello, world!' }], isError: false },
    );
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({ name: 'greeter', trust: true });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const result = await dispatcher.dispatch(
      makeCall(`greeter${MCP_TOOL_SEPARATOR}greet`, {}, 'call_xyz'),
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.callId).toBe('call_xyz');
      expect(result.content).toBe('Hello, world!');
    }
  });

  it('maps isError:true result to ToolFailure', async () => {
    const mockClient = makeMockClient(
      [{ name: 'fail_tool', inputSchema: { type: 'object', properties: {} } }],
      { content: [{ type: 'text', text: 'something broke' }], isError: true },
    );
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({ name: 'failer', trust: true });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const result = await dispatcher.dispatch(
      makeCall(`failer${MCP_TOOL_SEPARATOR}fail_tool`, {}, 'call_fail'),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('something broke');
    }
  });

  it('returns ToolFailure (not throw) when callTool throws', async () => {
    const mockClient = makeMockClient(
      [{ name: 'boom', inputSchema: { type: 'object', properties: {} } }],
      new Error('network error'),
    );
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({ name: 'boomer', trust: true });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const result = await dispatcher.dispatch(
      makeCall(`boomer${MCP_TOOL_SEPARATOR}boom`, {}, 'call_boom'),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('network error');
    }
  });

  it('injects env credential into transport (passes env to StdioClientTransport)', async () => {
    const mockClient = makeMockClient([
      { name: 'work', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({
      name: 'env-srv',
      transport: { kind: 'stdio', command: '/bin/srv', env: { BASE: 'base' } },
      auth: { kind: 'static', secret: 'tok-123', inject: { at: 'env', name: 'API_KEY' } },
    });
    await initMcpPool([config]);

    // StdioClientTransport should have been called with merged env
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/srv',
        env: { BASE: 'base', API_KEY: 'tok-123' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. FAIL OPEN — down server → zero tools, no throw
// ---------------------------------------------------------------------------

describe('McpDispatcher — FAIL OPEN', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPoolForTesting();
  });

  it('contributes zero tools when connect() throws', async () => {
    const mockClient = {
      connect: vi.fn().mockRejectedValue(new Error('spawn failed')),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient as unknown as InstanceType<typeof MockClient>;
    });

    const config = makeConnector({ name: 'down_srv' });
    const dispatcher = new McpDispatcher([config]);

    await initMcpPool([config]);
    expect(dispatcher.list()).toEqual([]);
  });

  it('contributes zero tools when listTools() throws', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockRejectedValue(new Error('list failed')),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient as unknown as InstanceType<typeof MockClient>;
    });

    const config = makeConnector({ name: 'list_fail_srv' });
    const dispatcher = new McpDispatcher([config]);

    await initMcpPool([config]);
    expect(dispatcher.list()).toEqual([]);
  });

  it('returns ToolFailure for dispatch when server is not connected', async () => {
    const mockClient = {
      connect: vi.fn().mockRejectedValue(new Error('spawn failed')),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient as unknown as InstanceType<typeof MockClient>;
    });

    const config = makeConnector({ name: 'conn_fail' });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]); // fails internally — pool entry ok=false

    const result = await dispatcher.dispatch(
      makeCall(`conn_fail${MCP_TOOL_SEPARATOR}anything`, {}, 'call_x'),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('execution_failed');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Connect TIMEOUT — hanging server fails open within bound
// ---------------------------------------------------------------------------

describe('McpDispatcher — connect TIMEOUT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPoolForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails open (zero tools, no throw) when connect() never resolves within timeout', async () => {
    let resolveHang!: () => void;
    const hangingPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const mockClient = {
      // connect never resolves — simulates a hung server
      connect: vi.fn().mockReturnValue(hangingPromise),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient as unknown as InstanceType<typeof MockClient>;
    });

    const config = makeConnector({ name: 'hanging_srv' });
    // McpDispatcher reads from the shared pool — initMcpPool populates it.
    const dispatcher = new McpDispatcher([config]);

    // Start the connect attempt and advance time past the timeout.
    const connectPromise = initMcpPool([config]);
    // Advance past the default 10s timeout (async variant flushes microtasks too)
    await vi.advanceTimersByTimeAsync(11_000);

    await connectPromise;
    expect(dispatcher.list()).toEqual([]);

    // Clean up the hanging promise so node doesn't complain
    resolveHang();
  });
});

// ---------------------------------------------------------------------------
// 8b. parseConnectTimeoutMs validation (Z08-26)
// ---------------------------------------------------------------------------

describe('parseConnectTimeoutMs', () => {
  it('returns defaultMs when raw is undefined', () => {
    expect(parseConnectTimeoutMs(undefined, 10_000)).toBe(10_000);
  });

  it('parses a valid numeric string', () => {
    expect(parseConnectTimeoutMs('5000', 10_000)).toBe(5_000);
  });

  it('clamps to 1000ms minimum when value is below 1000', () => {
    expect(parseConnectTimeoutMs('500', 10_000)).toBe(1_000);
  });

  it('falls back to defaultMs for a non-numeric string (NaN guard)', () => {
    expect(parseConnectTimeoutMs('abc', 10_000)).toBe(10_000);
  });

  it('falls back to defaultMs for "NaN"', () => {
    expect(parseConnectTimeoutMs('NaN', 10_000)).toBe(10_000);
  });

  it('falls back to defaultMs for an empty string', () => {
    expect(parseConnectTimeoutMs('', 10_000)).toBe(10_000);
  });

  it('falls back to defaultMs for Infinity', () => {
    expect(parseConnectTimeoutMs('Infinity', 10_000)).toBe(10_000);
  });

  it('falls back to defaultMs for a negative number', () => {
    expect(parseConnectTimeoutMs('-5000', 10_000)).toBe(10_000);
  });

  it('falls back to defaultMs for zero', () => {
    expect(parseConnectTimeoutMs('0', 10_000)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// 9. Materializer (C2.5)
// ---------------------------------------------------------------------------

describe('Materializer', () => {
  // Use os.tmpdir() in tests — never touch real /dev/shm.

  it('writes a file with the given content', async () => {
    const m = new Materializer(nodeOs.tmpdir());
    const { dir, cleanup } = await m.materialize('test-conn', [
      { path: 'key.json', content: '{"type":"service_account"}' },
    ]);
    try {
      const abs = nodePath.join(dir, 'key.json');
      const content = await fsPromises.readFile(abs, 'utf8');
      expect(content).toBe('{"type":"service_account"}');
    } finally {
      await cleanup();
    }
  });

  it('dir is 0700 and file is 0600', async () => {
    const m = new Materializer(nodeOs.tmpdir());
    const { dir, cleanup } = await m.materialize('mode-conn', [
      { path: 'secret.txt', content: 'hunter2' },
    ]);
    try {
      const abs = nodePath.join(dir, 'secret.txt');
      const dirStat = await fsPromises.stat(dir);
      const fileStat = await fsPromises.stat(abs);
      // Mode bits: last 12 bits, masked to permissions only
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      await cleanup();
    }
  });

  it('cleanup() removes the directory', async () => {
    const m = new Materializer(nodeOs.tmpdir());
    const { dir, cleanup } = await m.materialize('cleanup-conn', [
      { path: 'f.txt', content: 'data' },
    ]);
    await cleanup();
    await expect(fsPromises.access(dir)).rejects.toThrow();
  });

  it('registers created dirs in the active set, and cleanup unregisters them', async () => {
    const m = new Materializer(nodeOs.tmpdir());
    const active = _getActiveDirsForTesting();
    const sizeBefore = active.size;

    const { dir, cleanup } = await m.materialize('reg-conn', [{ path: 'f', content: 'x' }]);
    expect(active.size).toBe(sizeBefore + 1);
    expect(active.has(dir)).toBe(true);

    await cleanup();
    expect(active.has(dir)).toBe(false);
  });

  it('multiple dirs can be materialized and cleaned up independently', async () => {
    const m = new Materializer(nodeOs.tmpdir());
    const r1 = await m.materialize('multi-a', [{ path: 'a.txt', content: 'aaa' }]);
    const r2 = await m.materialize('multi-b', [{ path: 'b.txt', content: 'bbb' }]);
    try {
      // Both dirs exist.
      await expect(fsPromises.access(r1.dir)).resolves.toBeUndefined();
      await expect(fsPromises.access(r2.dir)).resolves.toBeUndefined();
    } finally {
      await r1.cleanup();
      await r2.cleanup();
    }
    // Both cleaned up.
    await expect(fsPromises.access(r1.dir)).rejects.toThrow();
    await expect(fsPromises.access(r2.dir)).rejects.toThrow();
  });

  it('rejects absolute file paths to prevent path traversal', async () => {
    const m = new Materializer(nodeOs.tmpdir());
    await expect(m.materialize('sec', [{ path: '/etc/passwd', content: 'x' }])).rejects.toThrow(
      /relative/,
    );
  });

  it('rejects .. path traversal', async () => {
    const m = new Materializer(nodeOs.tmpdir());
    await expect(m.materialize('sec', [{ path: '../escape', content: 'x' }])).rejects.toThrow(
      /parent/,
    );
  });
});

// ---------------------------------------------------------------------------
// 10. StaticProvider — file injection (C2.5)
// ---------------------------------------------------------------------------

describe('StaticProvider — file injection', () => {
  function makeFileProvider(secret: SecretMaterial, inject: Injection | Injection[]) {
    const m = new Materializer(nodeOs.tmpdir());
    const provider = new StaticProvider({ kind: 'static', secret, inject }, m);
    return provider;
  }

  it('string secret + file inject → apply:files, vars contains pointerEnv, file has correct content', async () => {
    const saKeyJson = '{"type":"service_account","project_id":"my-proj"}';
    const provider = makeFileProvider(saKeyJson, {
      at: 'file',
      path: 'key.json',
      pointerEnv: 'GOOGLE_APPLICATION_CREDENTIALS',
    });
    const cred = await provider.resolve();
    expect(cred.apply).toBe('files');
    if (cred.apply === 'files') {
      expect(typeof cred.dir).toBe('string');
      const gacPath = cred.vars['GOOGLE_APPLICATION_CREDENTIALS'];
      expect(gacPath).toBeDefined();
      expect(gacPath).toBe(nodePath.join(cred.dir, 'key.json'));
      const content = await fsPromises.readFile(gacPath!, 'utf8');
      expect(content).toBe(saKeyJson);
      // Clean up.
      await fsPromises.rm(cred.dir, { recursive: true, force: true });
    }
  });

  it('file inject without pointerEnv → vars is empty (no env pointer)', async () => {
    const provider = makeFileProvider('my-key-content', {
      at: 'file',
      path: 'key.pem',
      // no pointerEnv
    });
    const cred = await provider.resolve();
    expect(cred.apply).toBe('files');
    if (cred.apply === 'files') {
      expect(Object.keys(cred.vars)).toHaveLength(0);
      await fsPromises.rm(cred.dir, { recursive: true, force: true });
    }
  });

  it('record secret + file inject → throws (records not supported for file injection)', async () => {
    const provider = makeFileProvider(
      { user: 'alice', pass: 'hunter2' },
      { at: 'file', path: 'key.json', pointerEnv: 'KEY_PATH' },
    );
    await expect(provider.resolve()).rejects.toThrow(/Record secrets are not supported/);
  });

  it('file inject mixed with env in same array → throws (one channel)', async () => {
    const provider = makeFileProvider('secret', [
      { at: 'file', path: 'key.json', pointerEnv: 'KEY_PATH' },
      { at: 'env', name: 'EXTRA' },
    ]);
    await expect(provider.resolve()).rejects.toThrow(/one channel/);
  });

  it('file inject mixed with argv in same array → throws (one channel)', async () => {
    const provider = makeFileProvider('secret', [
      { at: 'file', path: 'key.json' },
      { at: 'argv', template: '--flag={{token}}' },
    ]);
    await expect(provider.resolve()).rejects.toThrow(/one channel/);
  });
});

// ---------------------------------------------------------------------------
// 11. buildTransport — files arm (C2.5)
// ---------------------------------------------------------------------------

describe('buildTransport — files arm', () => {
  beforeEach(() => {
    vi.mocked(MockStdioTransport).mockClear();
  });

  it('files credential on stdio merges vars into child env with transport.env as base', () => {
    buildTransport(
      { kind: 'stdio', command: 'gcloud', env: { BASE_VAR: 'base' } },
      {
        apply: 'files',
        dir: '/dev/shm/sym-mcp-gcp-abc',
        vars: { GOOGLE_APPLICATION_CREDENTIALS: '/dev/shm/sym-mcp-gcp-abc/key.json' },
      },
    );
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'gcloud',
        env: {
          BASE_VAR: 'base',
          GOOGLE_APPLICATION_CREDENTIALS: '/dev/shm/sym-mcp-gcp-abc/key.json',
        },
      }),
    );
  });

  it('files credential with no transport.env, only vars', () => {
    buildTransport(
      { kind: 'stdio', command: '/usr/bin/server' },
      {
        apply: 'files',
        dir: '/tmp/sym-mcp-x-123',
        vars: { CRED_PATH: '/tmp/sym-mcp-x-123/cred.json' },
      },
    );
    expect(vi.mocked(MockStdioTransport)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/usr/bin/server',
        env: { CRED_PATH: '/tmp/sym-mcp-x-123/cred.json' },
      }),
    );
  });

  it('files credential with empty vars and no transport.env → no env key in call', () => {
    buildTransport(
      { kind: 'stdio', command: '/usr/bin/server' },
      { apply: 'files', dir: '/tmp/sym-mcp-x-empty', vars: {} },
    );
    // env should not be passed when there's nothing to set
    const call = vi.mocked(MockStdioTransport).mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('env');
  });

  it('files credential does NOT throw (NotImplementedError is gone)', () => {
    expect(() =>
      buildTransport(
        { kind: 'stdio', command: '/bin/srv' },
        { apply: 'files', dir: '/tmp/dir', vars: { X: '/tmp/dir/k' } },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. tools.allow enforcement (Z08-01)
// ---------------------------------------------------------------------------

describe('McpDispatcher — tools.allow enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPoolForTesting();
  });

  it('without tools.allow, all server tools are exposed', async () => {
    const mockClient = makeMockClient([
      { name: 'tool_a', inputSchema: { type: 'object', properties: {} } },
      { name: 'tool_b', inputSchema: { type: 'object', properties: {} } },
      { name: 'tool_c', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({ name: 'srv_allow', trust: true });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const tools = dispatcher.list();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      `srv_allow${MCP_TOOL_SEPARATOR}tool_a`,
      `srv_allow${MCP_TOOL_SEPARATOR}tool_b`,
      `srv_allow${MCP_TOOL_SEPARATOR}tool_c`,
    ]);
  });

  it('with tools.allow, only the allowed tool is exposed (Z08-01)', async () => {
    // WATCHED FAIL: before the fix, this test would fail because tools.allow
    // was parsed but NOT applied — all 3 tools would appear.
    const mockClient = makeMockClient([
      { name: 'tool_a', inputSchema: { type: 'object', properties: {} } },
      { name: 'tool_b', inputSchema: { type: 'object', properties: {} } },
      { name: 'tool_c', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({
      name: 'srv_filtered',
      trust: true,
      tools: { allow: ['tool_b'] },
    });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const tools = dispatcher.list();
    // Only tool_b must be exposed; tool_a and tool_c are filtered out.
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(`srv_filtered${MCP_TOOL_SEPARATOR}tool_b`);
  });

  it('with tools.allow of multiple names, exactly those tools are exposed', async () => {
    const mockClient = makeMockClient([
      { name: 'alpha', inputSchema: { type: 'object', properties: {} } },
      { name: 'beta', inputSchema: { type: 'object', properties: {} } },
      { name: 'gamma', inputSchema: { type: 'object', properties: {} } },
      { name: 'delta', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({
      name: 'srv_multi',
      trust: true,
      tools: { allow: ['alpha', 'gamma'] },
    });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const tools = dispatcher.list();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual([
      `srv_multi${MCP_TOOL_SEPARATOR}alpha`,
      `srv_multi${MCP_TOOL_SEPARATOR}gamma`,
    ]);
  });

  it('with an empty tools.allow array, all tools are exposed (empty = no filter)', async () => {
    const mockClient = makeMockClient([
      { name: 'tool_x', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockImplementation(function () {
      return mockClient;
    });

    const config = makeConnector({
      name: 'srv_empty_allow',
      trust: true,
      tools: { allow: [] },
    });
    const dispatcher = new McpDispatcher([config]);
    await initMcpPool([config]);

    const tools = dispatcher.list();
    // Empty allow-list means no filter — all tools exposed.
    expect(tools).toHaveLength(1);
  });
});
