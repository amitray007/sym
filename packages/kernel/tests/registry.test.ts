/**
 * Tests for ToolRegistry — the kernel's tool routing wrapper.
 *
 * Pins:
 *   - constructor with null dispatcher (fail-closed behavior)
 *   - listTools() routing to the underlying dispatcher
 *   - hasTools() semantics
 *   - getDispatcher() access
 *   - dispatch() routing via the dispatcher (happy path + unknown tool)
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../src/tools.js';

import type {
  ConversationId,
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
    workspaceId: 'ws_test' as WorkspaceId,
    conversationId: 'ws_test:C1' as ConversationId,
    channelId: 'C1' as SlackChannelId,
    requester: 'U_tester' as SlackUserId,
    turnId: 'turn_reg_01' as TurnId,
  };
}

function makeCall(name: string, id = 'call_01'): ToolCall {
  return { id, name, arguments: {} };
}

const PING_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'ping',
  description: 'Returns pong',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  readOnlyHint: true,
};

const ECHO_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'echo',
  description: 'Echoes input',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    additionalProperties: false,
  },
  readOnlyHint: true,
};

/** A minimal ToolDispatcher implementation for testing ToolRegistry. */
function makeDispatcher(
  tools: ToolDescriptor[] = [PING_DESCRIPTOR, ECHO_DESCRIPTOR],
): ToolDispatcher {
  return {
    list(): ToolDescriptor[] {
      return tools;
    },
    async dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> {
      if (call.name === 'ping') {
        return { callId: call.id, ok: true, content: 'pong' };
      }
      if (call.name === 'echo') {
        const text = call.arguments['text'];
        return { callId: call.id, ok: true, content: String(text ?? '') };
      }
      return {
        callId: call.id,
        ok: false,
        error: { code: 'not_found', message: `Unknown tool: ${call.name}` },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry with no dispatcher
// ---------------------------------------------------------------------------

describe('ToolRegistry — no dispatcher (fail-closed defaults)', () => {
  it('listTools() returns [] when constructed with null', () => {
    const registry = new ToolRegistry(null);
    expect(registry.listTools()).toEqual([]);
  });

  it('listTools() returns [] when constructed with no argument (default null)', () => {
    const registry = new ToolRegistry();
    expect(registry.listTools()).toEqual([]);
  });

  it('hasTools() returns false when no dispatcher is registered', () => {
    const registry = new ToolRegistry(null);
    expect(registry.hasTools()).toBe(false);
  });

  it('getDispatcher() returns null when no dispatcher is registered', () => {
    const registry = new ToolRegistry(null);
    expect(registry.getDispatcher()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry with a dispatcher
// ---------------------------------------------------------------------------

describe('ToolRegistry — with dispatcher', () => {
  it('listTools() returns the full descriptor list from the dispatcher', () => {
    const registry = new ToolRegistry(makeDispatcher());
    const tools = registry.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['ping', 'echo']));
  });

  it('listTools() returns only the tools the dispatcher declares', () => {
    const dispatcher = makeDispatcher([PING_DESCRIPTOR]);
    const registry = new ToolRegistry(dispatcher);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listTools()[0]?.name).toBe('ping');
  });

  it('hasTools() returns true when the dispatcher has tools', () => {
    const registry = new ToolRegistry(makeDispatcher());
    expect(registry.hasTools()).toBe(true);
  });

  it('hasTools() returns false when the dispatcher declares no tools', () => {
    const registry = new ToolRegistry(makeDispatcher([]));
    expect(registry.hasTools()).toBe(false);
  });

  it('getDispatcher() returns the registered dispatcher', () => {
    const dispatcher = makeDispatcher();
    const registry = new ToolRegistry(dispatcher);
    expect(registry.getDispatcher()).toBe(dispatcher);
  });

  it('dispatch routes a known tool call through the dispatcher (ping → pong)', async () => {
    const registry = new ToolRegistry(makeDispatcher());
    const dispatcher = registry.getDispatcher();
    expect(dispatcher).not.toBeNull();
    if (dispatcher === null) throw new Error('expected dispatcher');
    const result = await dispatcher.dispatch(makeCall('ping'), makeCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.content).toBe('pong');
  });

  it('dispatch routes an unknown tool call and returns not_found', async () => {
    const registry = new ToolRegistry(makeDispatcher());
    const dispatcher = registry.getDispatcher();
    if (dispatcher === null) throw new Error('expected dispatcher');
    const result = await dispatcher.dispatch(makeCall('nonexistent_tool'), makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('not_found');
    expect(result.error.message).toContain('nonexistent_tool');
  });

  it('dispatch preserves the callId from the ToolCall', async () => {
    const registry = new ToolRegistry(makeDispatcher());
    const dispatcher = registry.getDispatcher();
    if (dispatcher === null) throw new Error('expected dispatcher');
    const result = await dispatcher.dispatch(makeCall('ping', 'unique-call-xyz'), makeCtx());
    expect(result.callId).toBe('unique-call-xyz');
  });

  it('dispatch passes arguments through to the underlying dispatcher', async () => {
    const registry = new ToolRegistry(makeDispatcher());
    const dispatcher = registry.getDispatcher();
    if (dispatcher === null) throw new Error('expected dispatcher');
    const call: ToolCall = { id: 'echo-call-01', name: 'echo', arguments: { text: 'hello world' } };
    const result = await dispatcher.dispatch(call, makeCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.content).toBe('hello world');
  });
});
