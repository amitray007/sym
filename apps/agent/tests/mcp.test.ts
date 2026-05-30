/**
 * Tests for the MCP client module (Chunk 1 — stdio dispatcher + composite).
 *
 * Covers:
 *  1. Config parsing (valid/invalid/empty MCP_SERVERS values)
 *  2. CompositeDispatcher prefix routing (builtin vs MCP)
 *  3. MCP result → ToolResult mapping
 *  4. FAIL OPEN (down server → zero tools, no throw)
 *
 * MCP Client/Transport are fully mocked — no real subprocess is spawned.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { CompositeDispatcher } from '../src/mcp/composite.js';
import { parseMcpServers } from '../src/mcp/config.js';
import { McpDispatcher, MCP_TOOL_SEPARATOR } from '../src/mcp/dispatcher.js';

import type { StdioMcpServerConfig } from '../src/mcp/config.js';
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

  it('parses a minimal valid stdio config', () => {
    const raw = JSON.stringify([{ name: 'my-server', command: '/usr/bin/server' }]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      transport: 'stdio',
      name: 'my-server',
      command: '/usr/bin/server',
    });
  });

  it('parses a full stdio config with args, env, and trust', () => {
    const raw = JSON.stringify([
      {
        name: 'full',
        command: '/bin/full',
        args: ['--port', '9000'],
        env: { TOKEN: 'abc123' },
        trust: true,
      },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(1);
    const cfg = result[0] as StdioMcpServerConfig;
    expect(cfg.args).toEqual(['--port', '9000']);
    expect(cfg.env).toEqual({ TOKEN: 'abc123' });
    expect(cfg.trust).toBe(true);
  });

  it('skips entries missing required name', () => {
    const raw = JSON.stringify([{ command: '/bin/server' }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries missing required command', () => {
    const raw = JSON.stringify([{ name: 'x' }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips unsupported transports', () => {
    const raw = JSON.stringify([{ name: 'x', command: '/bin/x', transport: 'http' }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries where args is not an array of strings', () => {
    const raw = JSON.stringify([{ name: 'x', command: '/bin/x', args: [1, 2] }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries where env is not a string record', () => {
    const raw = JSON.stringify([{ name: 'x', command: '/bin/x', env: { k: 42 } }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips entries where trust is not boolean', () => {
    const raw = JSON.stringify([{ name: 'x', command: '/bin/x', trust: 'yes' }]);
    expect(parseMcpServers(raw)).toEqual([]);
  });

  it('skips invalid entries while keeping valid ones', () => {
    const raw = JSON.stringify([
      { name: 'good', command: '/bin/good' },
      { command: '/bin/no-name' },
      { name: 'also-good', command: '/bin/also-good' },
    ]);
    const result = parseMcpServers(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'good' });
    expect(result[1]).toMatchObject({ name: 'also-good' });
  });

  it('does not set trust when trust is false or absent', () => {
    const raw = JSON.stringify([{ name: 'x', command: '/bin/x', trust: false }]);
    const result = parseMcpServers(raw);
    expect(result[0]).not.toHaveProperty('trust');
  });

  it('defaults transport to stdio when absent', () => {
    const raw = JSON.stringify([{ name: 'x', command: '/bin/x' }]);
    const result = parseMcpServers(raw);
    expect(result[0]).toMatchObject({ transport: 'stdio' });
  });
});

// ---------------------------------------------------------------------------
// 2. CompositeDispatcher routing
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
// 3. MCP result → ToolResult mapping + security annotations
// ---------------------------------------------------------------------------

// We mock the @modelcontextprotocol/sdk Client to avoid spawning processes.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn(),
  };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

import { Client as MockClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as MockTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

describe('McpDispatcher', () => {
  beforeEach(() => {
    // Clear the module-level pool between tests.
    // We do this by resetting the mock so each test controls its own client.
    vi.clearAllMocks();
  });

  it('list() returns namespaced tool descriptors for a healthy server', async () => {
    const mockClient = makeMockClient([
      {
        name: 'do_thing',
        description: 'does a thing',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    vi.mocked(MockClient).mockReturnValue(mockClient);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = { transport: 'stdio', name: 'srv', command: '/bin/srv' };
    const dispatcher = new McpDispatcher([config]);

    // Warm the pool directly.
    await dispatcher.listAsync();

    const tools = dispatcher.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(`srv${MCP_TOOL_SEPARATOR}do_thing`);
    expect(tools[0]?.description).toBe('does a thing');
  });

  it('sets destructiveHint:true on MCP tools when trust is not set', async () => {
    const mockClient = makeMockClient([
      { name: 'do_thing', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockReturnValue(mockClient);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = { transport: 'stdio', name: 'srv2', command: '/bin/srv' };
    const dispatcher = new McpDispatcher([config]);
    await dispatcher.listAsync();

    const tools = dispatcher.list();
    expect(tools[0]?.destructiveHint).toBe(true);
  });

  it('does NOT set destructiveHint when trust:true is set', async () => {
    const mockClient = makeMockClient([
      { name: 'do_thing', inputSchema: { type: 'object', properties: {} } },
    ]);
    vi.mocked(MockClient).mockReturnValue(mockClient);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = {
      transport: 'stdio',
      name: 'trusted',
      command: '/bin/srv',
      trust: true,
    };
    const dispatcher = new McpDispatcher([config]);
    await dispatcher.listAsync();

    const tools = dispatcher.list();
    expect(tools[0]?.destructiveHint).toBeUndefined();
  });

  it('maps text content result to ToolSuccess', async () => {
    const mockClient = makeMockClient(
      [{ name: 'greet', inputSchema: { type: 'object', properties: {} } }],
      { content: [{ type: 'text', text: 'Hello, world!' }], isError: false },
    );
    vi.mocked(MockClient).mockReturnValue(mockClient);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = {
      transport: 'stdio',
      name: 'greeter',
      command: '/bin/greeter',
      trust: true,
    };
    const dispatcher = new McpDispatcher([config]);
    await dispatcher.listAsync();

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
    vi.mocked(MockClient).mockReturnValue(mockClient);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = {
      transport: 'stdio',
      name: 'failer',
      command: '/bin/failer',
      trust: true,
    };
    const dispatcher = new McpDispatcher([config]);
    await dispatcher.listAsync();

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
    vi.mocked(MockClient).mockReturnValue(mockClient);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = {
      transport: 'stdio',
      name: 'boomer',
      command: '/bin/boomer',
      trust: true,
    };
    const dispatcher = new McpDispatcher([config]);
    await dispatcher.listAsync();

    // Should NOT throw — fail open as ToolFailure.
    const result = await dispatcher.dispatch(
      makeCall(`boomer${MCP_TOOL_SEPARATOR}boom`, {}, 'call_boom'),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('network error');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. FAIL OPEN — down server → zero tools, no throw
// ---------------------------------------------------------------------------

describe('McpDispatcher — FAIL OPEN', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('contributes zero tools when connect() throws', async () => {
    const mockClient = {
      connect: vi.fn().mockRejectedValue(new Error('spawn failed')),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = {
      transport: 'stdio',
      name: 'down_srv',
      command: '/bin/down',
    };
    const dispatcher = new McpDispatcher([config]);

    // Should not throw.
    await expect(dispatcher.listAsync()).resolves.toEqual([]);
    expect(dispatcher.list()).toEqual([]);
  });

  it('contributes zero tools when listTools() throws', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockRejectedValue(new Error('list failed')),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = {
      transport: 'stdio',
      name: 'list_fail_srv',
      command: '/bin/listfail',
    };
    const dispatcher = new McpDispatcher([config]);

    await expect(dispatcher.listAsync()).resolves.toEqual([]);
    expect(dispatcher.list()).toEqual([]);
  });

  it('returns ToolFailure for dispatch when server is not connected', async () => {
    const mockClient = {
      connect: vi.fn().mockRejectedValue(new Error('spawn failed')),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);
    vi.mocked(MockTransport).mockReturnValue({} as unknown as InstanceType<typeof MockTransport>);

    const config: StdioMcpServerConfig = {
      transport: 'stdio',
      name: 'conn_fail',
      command: '/bin/fail',
    };
    const dispatcher = new McpDispatcher([config]);
    await dispatcher.listAsync(); // fails internally — pool entry ok=false

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
