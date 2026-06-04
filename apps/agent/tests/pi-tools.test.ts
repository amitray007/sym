/**
 * pi-tools.test.ts — proves the "pi setup" (bridgeTools → Pi Agent) surfaces
 * MCP tools to the model, not just to the dispatcher.
 *
 * The earlier mcp.test.ts / integration tests prove the dispatcher path
 * (connect → list → dispatch). THIS test closes the remaining question from the
 * "Sym can't see the tools" debugging: that a registry containing MCP tools
 * (via CompositeDispatcher) is bridged into the Agent's tool list by the SAME
 * generic bridge that handles built-ins — so the model is advertised the MCP
 * tools and can call them.
 *
 * No SDK involved — CompositeDispatcher + bridgeTools are pure routing/mapping.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '@sym/kernel';
import { CompositeDispatcher } from '@sym/mcp-runtime';

import { bridgeTools } from '../src/pi/tools.js';

import type {
  ConversationId,
  SlackUserId,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

function descriptor(name: string): ToolDescriptor {
  return {
    type: 'function',
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
}

/** Minimal ToolDispatcher returning the given tool names and a fixed result. */
function stubDispatcher(names: string[], result: (call: ToolCall) => ToolResult): ToolDispatcher {
  return {
    list: () => names.map(descriptor),
    dispatch: (call: ToolCall) => Promise.resolve(result(call)),
  };
}

function makeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws_test' as WorkspaceId,
    conversationId: 'ws_test:C1' as ConversationId,
    requester: 'U_test' as SlackUserId,
    turnId: 'turn_test' as TurnId,
  };
}

const MCP_TOOL = 'shopify-dev-mcp__search_docs_chunks';

describe('bridgeTools — pi setup surfaces MCP tools to the Agent', () => {
  it('bridges MCP tools alongside built-ins into the Agent tool list', () => {
    const builtin = stubDispatcher(['read_channel'], (c) => ({
      callId: c.id,
      ok: true,
      content: 'builtin',
    }));
    const mcp = stubDispatcher([MCP_TOOL], (c) => ({ callId: c.id, ok: true, content: 'mcp' }));
    const registry = new ToolRegistry(new CompositeDispatcher(builtin, mcp));

    const tools = bridgeTools(registry, makeCtx());
    const names = tools.map((t) => t.name);

    // The MCP tool reaches the Agent's tool list (= advertised to the model),
    // via the exact same generic bridge as the built-in.
    expect(names).toContain('read_channel');
    expect(names).toContain(MCP_TOOL);
  });

  it('executing a bridged MCP tool dispatches through the registry to the MCP dispatcher', async () => {
    const builtin = stubDispatcher(['read_channel'], (c) => ({
      callId: c.id,
      ok: true,
      content: 'builtin',
    }));
    const mcp = stubDispatcher([MCP_TOOL], (c) => ({
      callId: c.id,
      ok: true,
      content: `mcp-result:${c.name}`,
    }));
    const registry = new ToolRegistry(new CompositeDispatcher(builtin, mcp));

    const tools = bridgeTools(registry, makeCtx());
    const mcpTool = tools.find((t) => t.name === MCP_TOOL);
    expect(mcpTool).toBeDefined();

    const out = await mcpTool!.execute('call_1', { prompt: 'how to create a product' });
    expect(out.content).toEqual([{ type: 'text', text: `mcp-result:${MCP_TOOL}` }]);
  });
});
