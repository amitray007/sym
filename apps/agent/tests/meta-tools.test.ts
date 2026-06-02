/**
 * C1 on-demand tools — find_tools / call_tool.
 *
 * Verifies the deferral mechanism that keeps MCP tool schemas OUT of the per-turn
 * tool array: built-ins stay native; MCP tools (`<server>__<tool>`) are reached
 * via find_tools (search) + call_tool (execute-by-name, through the real
 * ToolRegistry dispatcher), with owner-confirmation for destructive tools.
 */

import { describe, expect, it, vi } from 'vitest';

import { ToolRegistry } from '@sym/kernel';

import {
  buildConnectorCatalog,
  makeCallTool,
  makeFindTools,
  partitionDescriptors,
  searchDescriptors,
} from '../src/pi/meta-tools.js';

import type {
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
} from '@sym/contracts';

const ctx = {
  workspaceId: 'W1',
  conversationId: 'C1',
  requester: 'U1',
  turnId: 'T1',
} as unknown as ToolRuntimeContext;

function desc(name: string, description: string, destructive = true): ToolDescriptor {
  return {
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties: {} } as ToolDescriptor['parameters'],
    destructiveHint: destructive,
  };
}

const builtinSearch = desc('search', 'search the conversation', false);
const sentryList = desc('sentry__list_issues', 'list sentry issues and errors');
const sentryResolve = desc('sentry__resolve_issue', 'resolve a sentry issue');
const gcalCreate = desc('gcloud__create_event', 'create a calendar event');

function textOf(res: { content: readonly unknown[] }): string {
  return (res.content[0] as { text: string }).text;
}

function registryWith(
  dispatch: (call: ToolCall, c: ToolRuntimeContext) => Promise<ToolResult>,
): ToolRegistry {
  const dispatcher: ToolDispatcher = { list: () => [], dispatch };
  return new ToolRegistry(dispatcher);
}

describe('partitionDescriptors', () => {
  it('splits built-in (no __) from MCP (<server>__<tool>)', () => {
    const { builtin, mcp } = partitionDescriptors([builtinSearch, sentryList, gcalCreate]);
    expect(builtin.map((d) => d.name)).toEqual(['search']);
    expect(mcp.map((d) => d.name)).toEqual(['sentry__list_issues', 'gcloud__create_event']);
  });
});

describe('searchDescriptors', () => {
  it('ranks by term overlap', () => {
    const r = searchDescriptors([sentryResolve, sentryList, gcalCreate], 'sentry issues', 5);
    expect(r[0]?.name).toBe('sentry__list_issues'); // matches both "sentry" and "issues"
  });
  it('returns first N for an empty query', () => {
    expect(searchDescriptors([sentryList, gcalCreate], '', 1)).toHaveLength(1);
  });
});

describe('buildConnectorCatalog', () => {
  it('groups by connector with local tool names + the protocol instructions', () => {
    const cat = buildConnectorCatalog([sentryList, sentryResolve, gcalCreate]);
    expect(cat).toContain('- sentry (2): list_issues, resolve_issue');
    expect(cat).toContain('- gcloud (1): create_event');
    expect(cat).toContain('find_tools');
    expect(cat).toContain('call_tool');
  });
  it('is empty when there are no MCP tools', () => {
    expect(buildConnectorCatalog([])).toBe('');
  });
});

describe('find_tools', () => {
  it('returns matching tools (name + schema) and excludes non-matches', async () => {
    const tool = makeFindTools({ mcp: [sentryList, gcalCreate], cli: [] });
    const res = await tool.execute('id', { query: 'sentry' });
    const text = textOf(res);
    expect(text).toContain('sentry__list_issues');
    expect(text).not.toContain('gcloud__create_event');
  });
  it('also searches CLIs and returns them as run_cli capabilities', async () => {
    const tool = makeFindTools({
      mcp: [sentryList, gcalCreate],
      cli: [
        { bin: 'gcloud', description: 'Google Cloud Platform CLI' },
        { bin: 'jq', description: 'JSON processor' },
      ],
    });
    const res = await tool.execute('id', { query: 'cloud' });
    const text = textOf(res);
    expect(text).toContain('gcloud');
    expect(text).toContain('run_cli');
    expect(text).not.toContain('jq');
  });
  it('reports both connectors and CLIs when nothing matches', async () => {
    const tool = makeFindTools({
      mcp: [sentryList, gcalCreate],
      cli: [{ bin: 'gcloud' }],
    });
    const res = await tool.execute('id', { query: 'zzzznope' });
    expect(textOf(res)).toContain('No capability matched');
    expect(textOf(res)).toContain('gcloud');
  });
});

describe('call_tool', () => {
  it('confirms then dispatches a destructive tool by exact name', async () => {
    const dispatch = vi.fn(
      async (call: ToolCall): Promise<ToolResult> => ({
        callId: call.id,
        ok: true,
        content: `ran ${call.name}`,
      }),
    );
    const confirm = vi.fn(async () => true);
    const tool = makeCallTool({
      mcp: [sentryList],
      registry: registryWith(dispatch),
      ctx,
      confirm,
    });

    const res = await tool.execute('cid', {
      name: 'sentry__list_issues',
      arguments: { project: 'web' },
    });

    expect(confirm).toHaveBeenCalledWith('sentry__list_issues', { project: 'web' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(textOf(res)).toContain('ran sentry__list_issues');
  });

  it('throws on an unknown tool name (model must find_tools first)', async () => {
    const tool = makeCallTool({
      mcp: [sentryList],
      registry: registryWith(vi.fn()),
      ctx,
      confirm: vi.fn(async () => true),
    });
    await expect(tool.execute('cid', { name: 'nope__x' })).rejects.toThrow(/Unknown tool/);
  });

  it('blocks (and never dispatches) when the owner denies a destructive tool', async () => {
    const dispatch = vi.fn();
    const tool = makeCallTool({
      mcp: [sentryResolve],
      registry: registryWith(dispatch),
      ctx,
      confirm: async () => false,
    });
    await expect(
      tool.execute('cid', { name: 'sentry__resolve_issue', arguments: {} }),
    ).rejects.toThrow(/did not approve/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does NOT confirm a non-destructive tool', async () => {
    const readOnly = desc('sentry__list_issues', 'list', false);
    const dispatch = vi.fn(
      async (call: ToolCall): Promise<ToolResult> => ({ callId: call.id, ok: true, content: 'ok' }),
    );
    const confirm = vi.fn(async () => true);
    const tool = makeCallTool({ mcp: [readOnly], registry: registryWith(dispatch), ctx, confirm });
    await tool.execute('cid', { name: 'sentry__list_issues', arguments: {} });
    expect(confirm).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a dispatch failure as a thrown error', async () => {
    const dispatch = vi.fn(
      async (call: ToolCall): Promise<ToolResult> => ({
        callId: call.id,
        ok: false,
        error: { code: 'execution_failed', message: 'boom' },
      }),
    );
    const tool = makeCallTool({
      mcp: [sentryList],
      registry: registryWith(dispatch),
      ctx,
      confirm: async () => true,
    });
    await expect(
      tool.execute('cid', { name: 'sentry__list_issues', arguments: {} }),
    ).rejects.toThrow(/execution_failed.*boom/);
  });
});
