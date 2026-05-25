/**
 * McpToolRegistry unit tests.
 *
 * Uses StubMcpTransport so no real MCP servers or network are needed.
 * Uses a mock audit function so no real DB is needed.
 */

import { describe, expect, it, vi } from 'vitest';

import { McpToolRegistry } from './registry.js';
import { StubMcpTransport } from './stub-server.js';

import type { McpServerConfig } from './types.js';
import type {
  ConversationId,
  SandboxId,
  SandboxJwtId,
  SlackUserId,
  ToolRuntimeContext,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const noopAuditFn = vi.fn().mockResolvedValue({
  id: 1,
  workspaceId: 'ws-1',
  kind: 'app.tool.call',
  actorKind: 'sandbox',
  actorId: 'sandbox-1',
  payload: {},
  ts: new Date(),
});

// Minimal fake DB — audit writes are mocked anyway.
const fakeDb = {} as Parameters<(typeof McpToolRegistry)['prototype']['connect']>[0] extends never
  ? never
  : any;

function makeRuntimeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws-1' as WorkspaceId,
    conversationId: 'ws-1:C1' as ConversationId,
    requester: 'U123' as SlackUserId,
    turnId: 'turn-1' as TurnId,
    sandbox: {
      sandboxId: 'sbx-1' as SandboxId,
      jti: 'jti-1' as SandboxJwtId,
      requester: 'U123' as SlackUserId,
      turnId: 'turn-1' as TurnId,
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    },
  };
}

const stubTool = {
  name: 'search',
  description: 'Search something',
  inputSchema: { type: 'object' as const, properties: { q: { type: 'string' as const } } },
};

const httpConfig: McpServerConfig = {
  id: 'cfg-1',
  workspaceId: 'ws-1',
  name: 'Test Server',
  slug: 'test',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpToolRegistry', () => {
  it('list() returns ToolDescriptors from connected servers', async () => {
    const stub = new StubMcpTransport({ tools: [stubTool] });

    const registry = new McpToolRegistry(fakeDb, noopAuditFn, (_config) => stub);

    await registry.connect([httpConfig]);

    const tools = registry.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('mcp__test__search');
    expect(tools[0]?.type).toBe('function');
    expect(tools[0]?.description).toBe('Search something');
  });

  it('dispatch() routes call to correct server and returns result', async () => {
    const stub = new StubMcpTransport({
      tools: [stubTool],
      callHandler: (_name, args) => ({
        content: `searched: ${String(args['q'] ?? '')}`,
        isError: false,
      }),
    });

    const registry = new McpToolRegistry(fakeDb, noopAuditFn, (_config) => stub);

    await registry.connect([httpConfig]);

    const result = await registry.dispatch(
      { id: 'call-1', name: 'mcp__test__search', arguments: { q: 'hello' } },
      makeRuntimeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('searched: hello');
    }
  });

  it('dispatch() returns not_found for unknown tool name format', async () => {
    const stub = new StubMcpTransport({ tools: [stubTool] });
    const registry = new McpToolRegistry(fakeDb, noopAuditFn, () => stub);
    await registry.connect([httpConfig]);

    const result = await registry.dispatch(
      { id: 'call-1', name: 'some_unknown_tool', arguments: {} },
      makeRuntimeCtx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('dispatch() returns not_found for unknown server slug', async () => {
    const stub = new StubMcpTransport({ tools: [stubTool] });
    const registry = new McpToolRegistry(fakeDb, noopAuditFn, () => stub);
    await registry.connect([httpConfig]);

    const result = await registry.dispatch(
      { id: 'call-1', name: 'mcp__unknown_slug__search', arguments: {} },
      makeRuntimeCtx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('dispatch() returns execution_failed when MCP tool call throws', async () => {
    const stub = new StubMcpTransport({
      tools: [stubTool],
      callHandler: () => {
        throw new Error('MCP server error');
      },
    });
    const registry = new McpToolRegistry(fakeDb, noopAuditFn, () => stub);
    await registry.connect([httpConfig]);

    const result = await registry.dispatch(
      { id: 'call-1', name: 'mcp__test__search', arguments: {} },
      makeRuntimeCtx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('execution_failed');
    }
  });

  it('list() aggregates tools from multiple servers', async () => {
    const stub1 = new StubMcpTransport({
      tools: [{ name: 'tool-a', inputSchema: { type: 'object' } }],
    });
    const stub2 = new StubMcpTransport({
      tools: [{ name: 'tool-b', inputSchema: { type: 'object' } }],
    });

    const configs: McpServerConfig[] = [
      { ...httpConfig, slug: 'server-a' },
      { ...httpConfig, id: 'cfg-2', slug: 'server-b' },
    ];

    let callCount = 0;
    const registry = new McpToolRegistry(fakeDb, noopAuditFn, (_config) =>
      callCount++ === 0 ? stub1 : stub2,
    );

    await registry.connect(configs);

    const tools = registry.list();
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain('mcp__server-a__tool-a');
    expect(names).toContain('mcp__server-b__tool-b');
  });

  it('emits audit events on list and dispatch', async () => {
    const auditFn = vi.fn().mockResolvedValue({
      id: 1,
      workspaceId: 'ws-1',
      kind: 'app.tool.call',
      actorKind: 'sandbox',
      actorId: 'sandbox-1',
      payload: {},
      ts: new Date(),
    });

    const stub = new StubMcpTransport({ tools: [stubTool] });
    const registry = new McpToolRegistry(fakeDb, auditFn, () => stub);
    await registry.connect([httpConfig]);

    await registry.dispatch(
      { id: 'call-1', name: 'mcp__test__search', arguments: { q: 'test' } },
      makeRuntimeCtx(),
    );

    // Wait for async audit fire-and-forget
    await new Promise((r) => setTimeout(r, 10));

    expect(auditFn).toHaveBeenCalled();
    const kinds = auditFn.mock.calls.map((c: unknown[]) => (c[1] as { kind: string }).kind);
    expect(kinds).toContain('app.tool.call');
  });
});
