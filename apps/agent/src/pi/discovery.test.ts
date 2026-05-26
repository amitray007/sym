/**
 * Tests for buildDiscoveryTools (search_tools + call_tool meta-tools).
 *
 * These are hermetic unit tests — no Pi Agent, no Fireworks, no DB.
 * We invoke the AgentTool.execute functions directly.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildDiscoveryTools } from './discovery.js';

import type { ToolDescriptor, ToolDispatcher, ToolResult } from '@sym/contracts';
import type { ToolRegistry } from '@sym/kernel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    type: 'function',
    name: 'mcp__test__do_thing',
    description: 'Does a test thing with frobnicators.',
    parameters: {
      type: 'object',
      properties: { frob: { type: 'string' } },
      required: ['frob'],
      additionalProperties: false,
    },
    ...overrides,
  };
}

function makeRegistry(dispatches: Record<string, ToolResult>): ToolRegistry {
  const dispatcher: ToolDispatcher = {
    list: () => [],
    dispatch: vi.fn(async (call) => {
      const result = dispatches[call.name];
      if (!result) throw new Error(`unexpected dispatch: ${call.name}`);
      return result;
    }),
  };
  return {
    listTools: () => [],
    hasTools: () => false,
    getDispatcher: () => dispatcher,
  } as unknown as ToolRegistry;
}

const BASE_CTX = {
  workspaceId: 'ws_1' as ToolDescriptor['name'], // branded type shortcut
  conversationId: 'conv_1' as ToolDescriptor['name'],
  requester: 'U_owner' as ToolDescriptor['name'],
  turnId: 'turn_1' as ToolDescriptor['name'],
};

// ---------------------------------------------------------------------------
// search_tools
// ---------------------------------------------------------------------------

describe('buildDiscoveryTools – search_tools', () => {
  it('returns two tools (search_tools + call_tool)', () => {
    const tools = buildDiscoveryTools({
      connectorDescriptors: [makeDescriptor()],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
    });
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('search_tools');
    expect(tools[1]!.name).toBe('call_tool');
  });

  it('finds a descriptor that matches query by name', async () => {
    const desc = makeDescriptor({
      name: 'mcp__gmail__search_emails',
      description: 'Search emails in Gmail',
    });
    const [searchTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
    });

    const result = await searchTool!.execute('tc1', { query: 'gmail' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('mcp__gmail__search_emails');
    expect(text).toContain('call_tool');
  });

  it('finds a descriptor that matches query by description', async () => {
    const desc = makeDescriptor({ description: 'Creates a new calendar event' });
    const [searchTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
    });

    const result = await searchTool!.execute('tc1', { query: 'calendar' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('mcp__test__do_thing');
  });

  it('returns no-match message when nothing matches', async () => {
    const desc = makeDescriptor();
    const [searchTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
    });

    const result = await searchTool!.execute('tc1', { query: 'xyzzy_nonexistent' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No connector tools matched');
    expect(text).toContain('mcp__test__do_thing');
  });

  it('includes parameters schema in the match listing', async () => {
    const desc = makeDescriptor({ name: 'mcp__test__frob_it' });
    const [searchTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
    });

    const result = await searchTool!.execute('tc1', { query: 'frob' });
    const text = result.content[0]?.text ?? '';
    // Parameters JSON should appear in the listing
    expect(text).toContain('"frob"');
  });
});

// ---------------------------------------------------------------------------
// call_tool – happy path
// ---------------------------------------------------------------------------

describe('buildDiscoveryTools – call_tool', () => {
  it('dispatches a known tool and returns the result text', async () => {
    const desc = makeDescriptor({ name: 'mcp__test__do_thing' });
    const registry = makeRegistry({
      mcp__test__do_thing: { callId: 'tc1', ok: true, content: 'it worked' },
    });

    const [, callTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry,
      ctx: BASE_CTX as never,
    });

    const result = await callTool!.execute('tc1', {
      name: 'mcp__test__do_thing',
      args: { frob: 'hello' },
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toBe('it worked');
  });

  it('returns a helpful error when tool name is unknown', async () => {
    const desc = makeDescriptor({ name: 'mcp__test__do_thing' });
    const [, callTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
    });

    const result = await callTool!.execute('tc1', { name: 'mcp__test__nonexistent', args: {} });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Unknown connector tool');
    expect(text).toContain('mcp__test__do_thing');
  });

  it('surfaces dispatcher error as text (not a throw)', async () => {
    const desc = makeDescriptor({ name: 'mcp__test__do_thing' });
    const registry = makeRegistry({
      mcp__test__do_thing: {
        callId: 'tc1',
        ok: false,
        error: { code: 'execution_failed', message: 'something broke' },
      },
    });

    const [, callTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry,
      ctx: BASE_CTX as never,
    });

    const result = await callTool!.execute('tc1', {
      name: 'mcp__test__do_thing',
      args: { frob: 'x' },
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('failed');
    expect(text).toContain('something broke');
  });
});

// ---------------------------------------------------------------------------
// call_tool – destructive gating
// ---------------------------------------------------------------------------

describe('buildDiscoveryTools – call_tool destructive gating', () => {
  it('blocks a destructive tool when slackClient is absent (fail closed)', async () => {
    const desc = makeDescriptor({ name: 'mcp__test__destroy', destructiveHint: true });
    const [, callTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
      // No slackClient → fail closed
    });

    const result = await callTool!.execute('tc1', { name: 'mcp__test__destroy', args: {} });
    const text = result.content[0]?.text ?? '';
    // The text says "Blocked." (capital B) — check for "Blocked" case-insensitively.
    expect(text.toLowerCase()).toContain('blocked');
  });

  it('blocks a destructive tool when channelId is absent (fail closed)', async () => {
    const desc = makeDescriptor({ name: 'mcp__test__destroy', destructiveHint: true });
    const [, callTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry: makeRegistry({}),
      ctx: BASE_CTX as never,
      slackClient: {} as never, // client present but no channelId
      // No channelId → fail closed
    });

    const result = await callTool!.execute('tc1', { name: 'mcp__test__destroy', args: {} });
    const text = result.content[0]?.text ?? '';
    expect(text.toLowerCase()).toContain('blocked');
  });

  it('dispatches a non-destructive tool without confirmation', async () => {
    const desc = makeDescriptor({ name: 'mcp__test__safe_read', readOnlyHint: true });
    const registry = makeRegistry({
      mcp__test__safe_read: { callId: 'tc1', ok: true, content: 'read result' },
    });

    const [, callTool] = buildDiscoveryTools({
      connectorDescriptors: [desc],
      registry,
      ctx: BASE_CTX as never,
      // No slackClient/channelId — should NOT block non-destructive tools
    });

    const result = await callTool!.execute('tc1', { name: 'mcp__test__safe_read', args: {} });
    const text = result.content[0]?.text ?? '';
    expect(text).toBe('read result');
  });
});
