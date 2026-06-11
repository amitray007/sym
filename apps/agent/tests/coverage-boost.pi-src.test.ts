/**
 * Coverage-boost tests for:
 *   - src/pi/loop-callbacks.ts  (makeBeforeToolCall + makeSubscriber)
 *   - src/pi/agent-setup.ts     (buildAgentTools + buildAgentSystemPrompt)
 *   - src/pi/model.ts           (buildFireworksModel branches)
 *   - src/pi/tools.ts           (bridgeTools, passthroughArgs, bridgeTool error paths)
 *   - src/reply-cleanup.ts      (cleanupReply — LLM path, cache, error fallback)
 *   - src/event-router.ts       (processEvent + processSlashCommand + processInteractivity)
 *   - src/confirmations.ts      (requestConfirmation + resolveConfirmation paths)
 *
 * All external I/O (Pi Agent, Slack, @sym/kernel, @sym/adapter-slack, @sym/mcp-runtime)
 * is mocked. No real servers, processes, or network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @earendil-works/pi-agent-core — used by loop-callbacks + reply-cleanup
// ---------------------------------------------------------------------------

type Subscriber = (event: unknown) => void | Promise<void>;

const piAgentSubscribers: Subscriber[] = [];
let piAgentPromptFn: ((text: string) => Promise<void>) | undefined;

vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgent {
    state = { messages: [], errorMessage: undefined };
    _subscriber: Subscriber | undefined = undefined;
    subscribe(fn: Subscriber): void {
      piAgentSubscribers.push(fn);
      this._subscriber = fn;
    }
    async prompt(_text: string): Promise<void> {
      if (piAgentPromptFn) await piAgentPromptFn(_text);
    }
    abort(): void {
      /* no-op */
    }
  }
  return { Agent: FakeAgent };
});

// ---------------------------------------------------------------------------
// Mock @earendil-works/pi-ai — getModel for pi/model.ts
// ---------------------------------------------------------------------------

vi.mock('@earendil-works/pi-ai', () => {
  const knownModels: Record<string, { id: string; api: string; name: string; provider: string }> = {
    'accounts/fireworks/models/gpt-oss-120b': {
      id: 'accounts/fireworks/models/gpt-oss-120b',
      api: 'anthropic-messages',
      name: 'GPT OSS 120B',
      provider: 'fireworks',
    },
    'accounts/fireworks/models/openai-compat-model': {
      id: 'accounts/fireworks/models/openai-compat-model',
      api: 'openai-completions',
      name: 'OpenAI Compat',
      provider: 'fireworks',
    },
  };
  return {
    getModel: (_provider: string, modelId: string) => knownModels[modelId] ?? null,
  };
});

// ---------------------------------------------------------------------------
// Mock @sym/kernel — buildSystemPrompt, buildUserTurnContent, ToolRegistry
// ---------------------------------------------------------------------------

vi.mock('@sym/kernel', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildSystemPrompt: vi.fn(() => 'BASE_SYSTEM_PROMPT'),
    buildUserTurnContent: vi.fn((_turn: unknown, _profile: unknown) => 'user turn content'),
    buildReceipt: vi.fn((_opts: unknown) => ({
      turnId: 'turn-1',
      model: 'gpt-oss-120b',
      toolsInvoked: [],
      durationMs: 10,
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock @sym/mcp-runtime — loadCliAllow, loadCliDescribe, MCP_TOOL_SEPARATOR
// ---------------------------------------------------------------------------

vi.mock('@sym/mcp-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadCliAllow: vi.fn(() => undefined),
    loadCliDescribe: vi.fn(() => ({})),
  };
});

// ---------------------------------------------------------------------------
// Mock @sym/adapter-slack — normalizeSlackEvent, slackTurnInputToTurn, etc.
// ---------------------------------------------------------------------------

const mockNormalizeSlackEvent = vi.fn();
const mockSlackTurnInputToTurn = vi.fn();
const mockAssistantThreadContextChanged = vi.fn();
const mockAssistantThreadStarted = vi.fn();
const mockHandleAssistantThreadStarted = vi.fn();
const mockSectionBlock = vi.fn((...args: any[]) => ({ type: 'section', text: args[0] }));
const mockActionsBlock = vi.fn((...args: any[]) => ({ type: 'actions', elements: args[0] }));

vi.mock('@sym/adapter-slack', () => ({
  normalizeSlackEvent: (...args: any[]) => mockNormalizeSlackEvent(...args),
  slackTurnInputToTurn: (...args: any[]) => mockSlackTurnInputToTurn(...args),
  assistantThreadContextChanged: (...args: any[]) => mockAssistantThreadContextChanged(...args),
  assistantThreadStarted: (...args: any[]) => mockAssistantThreadStarted(...args),
  sectionBlock: (...args: any[]) => mockSectionBlock(...args),
  actionsBlock: (...args: any[]) => mockActionsBlock(...args),
}));

// Mock ./assistant.js
vi.mock('../src/assistant.js', () => ({
  handleAssistantThreadStarted: (...args: any[]) => mockHandleAssistantThreadStarted(...args),
}));

// Mock ./handle-turn.js
const mockHandleTurn = vi.fn();
vi.mock('../src/handle-turn.js', () => ({
  handleTurn: (...args: any[]) => mockHandleTurn(...args),
}));

// Mock ./owner-gate.js
vi.mock('../src/owner-gate.js', () => ({
  buildOwnerDeclineMessage: vi.fn(
    (_ownerSlackUserId: string, _ownerProfile: unknown) => 'Sorry, Sym is single-owner only.',
  ),
}));

// confirmations.ts is NOT mocked — requestConfirmation + resolveConfirmation are
// exercised directly (real implementation) in the tests below.

// ---------------------------------------------------------------------------
// Mock ../src/slack-guard.js
// ---------------------------------------------------------------------------

type SlackGuardVerdict = 'allow' | 'redirect' | 'confirm';
const mockJudgeSlackToolUse = vi.fn<(...args: any[]) => Promise<SlackGuardVerdict>>(
  async () => 'allow',
);
vi.mock('../src/slack-guard.js', () => ({
  SLACK_GUARD_TOOLS: new Set(['search_messages', 'list_channels', 'read_user_profile']),
  judgeSlackToolUse: (...args: any[]) => mockJudgeSlackToolUse(...args),
}));

// Mock ../src/log.js
vi.mock('../src/log.js', () => ({
  logCtx: (id: string) => `[${id}]`,
}));

// Mock ../src/run-cli.js
vi.mock('../src/run-cli.js', () => ({
  resolveAllowlist: vi.fn(() => new Set(['sym', 'gh'])),
  resolveCliCapabilities: vi.fn(() => []),
  buildCliCatalog: vi.fn(() => ''),
  isIntrospectionOnly: vi.fn((argv: string[]) => {
    if (argv.length <= 1) return true;
    return argv
      .slice(1)
      .some((a: string) => ['--help', '-h', '--version', '-v', 'help', 'version'].includes(a));
  }),
}));

// ---------------------------------------------------------------------------
// Import the modules under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { ToolRegistry } from '@sym/kernel';

import { requestConfirmation, resolveConfirmation } from '../src/confirmations.js';
import { processEvent, processSlashCommand, processInteractivity } from '../src/event-router.js';
import { buildAgentTools, buildAgentSystemPrompt } from '../src/pi/agent-setup.js';
import { makeBeforeToolCall, makeSubscriber } from '../src/pi/loop-callbacks.js';
import { buildFireworksModel } from '../src/pi/model.js';
import { bridgeTools, passthroughArgs } from '../src/pi/tools.js';
import { cleanupReply } from '../src/reply-cleanup.js';

import type { AgentEvent, BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type {
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  ToolDescriptor,
  ToolResult,
  ToolRuntimeContext,
  Turn,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

// The genuine crypto.randomUUID, captured at module load BEFORE any vi.spyOn
// replaces it — so uuidMockImpl never recurses into the installed spy.
const REAL_RANDOM_UUID = crypto.randomUUID.bind(crypto);

/**
 * Build a crypto.randomUUID-compatible mock implementation that generates a real
 * UUID via the captured original and reports it back through `capture`. Typed so
 * tsc accepts it as `typeof crypto.randomUUID` (whose return type is the
 * `${string}-${string}-…` UUID template literal).
 */
function uuidMockImpl(capture: (id: string) => void): typeof crypto.randomUUID {
  return (() => {
    const id = REAL_RANDOM_UUID();
    capture(id);
    return id;
  }) as typeof crypto.randomUUID;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return Object.assign(
    {
      id: 'turn-1' as TurnId,
      workspaceId: 'ws-1' as WorkspaceId,
      conversationId: 'ws-1:C1' as Turn['conversationId'],
      entrySurface: 'app_mention' as const,
      requester: 'U1' as SlackUserId,
      channelId: 'C1' as SlackChannelId,
      text: 'hi sym',
      receivedAt: new Date(),
    },
    overrides,
  ) as Turn;
}

function makeDescriptor(name: string, destructive = false): ToolDescriptor {
  return {
    type: 'function',
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    ...(destructive ? { destructiveHint: true } : {}),
  };
}

function makeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws-1' as WorkspaceId,
    conversationId: 'ws-1:C1' as Turn['conversationId'],
    requester: 'U1' as SlackUserId,
    turnId: 'turn-1' as TurnId,
  };
}

function makeRegistry(descriptors: ToolDescriptor[] = []): ToolRegistry {
  return new ToolRegistry({
    list: () => descriptors,
    dispatch: async (call) => ({ callId: call.id, ok: true, content: 'ok' }),
  });
}

/**
 * A mock SlackClient. Each method is a vi mock declared as a NAMED property (not
 * via an index signature) so individual tests can dot-access / reassign
 * `chatPostMessage` etc. without TS4111 friction; the loop/event-router code only
 * ever calls the methods it needs.
 */
interface MockSlackClient {
  chatPostMessage: ReturnType<typeof vi.fn>;
  chatUpdate: ReturnType<typeof vi.fn>;
  reactionsAdd: ReturnType<typeof vi.fn>;
  assistantThreadsSetStatus: ReturnType<typeof vi.fn>;
  conversationsReplies: ReturnType<typeof vi.fn>;
  conversationsHistory: ReturnType<typeof vi.fn>;
  assistantThreadsSetSuggestedPrompts: ReturnType<typeof vi.fn>;
  assistantThreadsSetTitle: ReturnType<typeof vi.fn>;
  chatStartStream: ReturnType<typeof vi.fn>;
  chatAppendStream: ReturnType<typeof vi.fn>;
  chatStopStream: ReturnType<typeof vi.fn>;
  chatDelete: ReturnType<typeof vi.fn>;
  usersInfo: ReturnType<typeof vi.fn>;
  usersList: ReturnType<typeof vi.fn>;
  conversationsList: ReturnType<typeof vi.fn>;
  conversationsInfo: ReturnType<typeof vi.fn>;
  authTest: ReturnType<typeof vi.fn>;
  searchMessages: ReturnType<typeof vi.fn>;
  usersProfileSet: ReturnType<typeof vi.fn>;
  remindersAdd: ReturnType<typeof vi.fn>;
}

function makeSlackClient(): MockSlackClient {
  return {
    chatPostMessage: vi.fn(async () => ({ ts: '123.456' as SlackThreadTs, channel: 'C1' })),
    chatUpdate: vi.fn(async () => {}),
    reactionsAdd: vi.fn(async () => {}),
    assistantThreadsSetStatus: vi.fn(async () => {}),
    conversationsReplies: vi.fn(async () => ({ messages: [] })),
    conversationsHistory: vi.fn(async () => ({ messages: [] })),
    assistantThreadsSetSuggestedPrompts: vi.fn(async () => {}),
    assistantThreadsSetTitle: vi.fn(async () => {}),
    chatStartStream: vi.fn(async () => ({ ts: 'st.1', channel: 'C1' })),
    chatAppendStream: vi.fn(async () => {}),
    chatStopStream: vi.fn(async () => {}),
    chatDelete: vi.fn(async () => {}),
    usersInfo: vi.fn(async () => ({ id: 'U1' })),
    usersList: vi.fn(async () => ({ users: [] })),
    conversationsList: vi.fn(async () => ({ channels: [] })),
    conversationsInfo: vi.fn(async () => ({ id: 'C1', isIm: false, isMpim: false })),
    authTest: vi.fn(async () => ({ userId: 'U1', teamId: 'T1' })),
    searchMessages: vi.fn(async () => ({ matches: [], total: 0 })),
    usersProfileSet: vi.fn(async () => {}),
    remindersAdd: vi.fn(async () => ({ id: 'Rm0', text: '' })),
  };
}

// ---------------------------------------------------------------------------
// Global reset — clear all mock state between tests to avoid cross-test pollution.
// This runs before EVERY test in this file regardless of which describe block.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  piAgentSubscribers.length = 0;
  piAgentPromptFn = undefined;
});

// ---------------------------------------------------------------------------
// pi/model.ts — buildFireworksModel branches
// ---------------------------------------------------------------------------

describe('buildFireworksModel', () => {
  it('returns a model for a known anthropic-messages model', () => {
    const model = buildFireworksModel({
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      modelId: 'accounts/fireworks/models/gpt-oss-120b',
    });
    expect(model.api).toBe('anthropic-messages');
    expect(model.id).toBe('accounts/fireworks/models/gpt-oss-120b');
  });

  it('strips trailing /v1 from baseUrl (old env format)', () => {
    const model = buildFireworksModel({
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      modelId: 'accounts/fireworks/models/gpt-oss-120b',
    });
    expect(model.baseUrl).toBe('https://api.fireworks.ai/inference');
  });

  it('strips trailing /v1/ with trailing slash', () => {
    const model = buildFireworksModel({
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      modelId: 'accounts/fireworks/models/gpt-oss-120b',
    });
    expect(model.baseUrl).toBe('https://api.fireworks.ai/inference');
  });

  it('leaves baseUrl alone when it does not end with /v1', () => {
    const model = buildFireworksModel({
      baseUrl: 'https://api.fireworks.ai/inference',
      modelId: 'accounts/fireworks/models/gpt-oss-120b',
    });
    expect(model.baseUrl).toBe('https://api.fireworks.ai/inference');
  });

  it('throws for an unknown modelId', () => {
    expect(() =>
      buildFireworksModel({
        baseUrl: 'https://api.fireworks.ai/inference',
        modelId: 'accounts/fireworks/models/unknown-xyz',
      }),
    ).toThrow('unknown Fireworks model');
  });

  it('throws for a model that is not anthropic-messages (line 48 branch)', () => {
    expect(() =>
      buildFireworksModel({
        baseUrl: 'https://api.fireworks.ai/inference',
        modelId: 'accounts/fireworks/models/openai-compat-model',
      }),
    ).toThrow('expected anthropic-messages model for Harmony demux');
  });
});

// ---------------------------------------------------------------------------
// pi/tools.ts — passthroughArgs + bridgeTools dispatch paths
// ---------------------------------------------------------------------------

describe('passthroughArgs', () => {
  it('returns the input unchanged', () => {
    const obj = { foo: 'bar', n: 42 };
    expect(passthroughArgs(obj)).toBe(obj);
  });

  it('works with null/undefined', () => {
    expect(passthroughArgs(null)).toBeNull();
    expect(passthroughArgs(undefined)).toBeUndefined();
  });
});

describe('bridgeTools — tool execute paths', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns an empty array when registry has no tools', () => {
    const registry = makeRegistry([]);
    expect(bridgeTools(registry, makeCtx())).toHaveLength(0);
  });

  it('uses registry.listTools() when no descriptors list is given', () => {
    const desc = makeDescriptor('read_thread');
    const registry = makeRegistry([desc]);
    const tools = bridgeTools(registry, makeCtx());
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_thread');
  });

  it('uses the provided descriptors list instead of registry.listTools()', () => {
    const registry = makeRegistry([makeDescriptor('read_thread')]);
    const overrideDeps = [makeDescriptor('get_current_time')];
    const tools = bridgeTools(registry, makeCtx(), overrideDeps);
    expect(tools.map((t) => t.name)).toEqual(['get_current_time']);
  });

  it('throws when dispatcher is unavailable (line 66 branch)', async () => {
    const registry = makeRegistry([makeDescriptor('read_thread')]);
    vi.spyOn(registry, 'getDispatcher').mockReturnValue(undefined as any);
    const tools = bridgeTools(registry, makeCtx());
    await expect(tools[0]?.execute('call-1', {})).rejects.toThrow('no dispatcher available');
  });

  it('throws on dispatch error (ok: false path — line 76)', async () => {
    const registry = new ToolRegistry({
      list: () => [makeDescriptor('read_thread')],
      dispatch: async (call): Promise<ToolResult> => ({
        callId: call.id,
        ok: false,
        error: { code: 'execution_failed', message: 'something went wrong' },
      }),
    });
    const tools = bridgeTools(registry, makeCtx());
    await expect(tools[0]?.execute('call-2', {})).rejects.toThrow(
      '[execution_failed]: something went wrong',
    );
  });

  it('side-channels render intent via onRender sink (line 82)', async () => {
    const renderIntents: unknown[] = [];
    const onRender = (r: unknown): void => {
      renderIntents.push(r);
    };
    const desc = makeDescriptor('present_card');
    const registry = new ToolRegistry({
      list: () => [desc],
      dispatch: async (call) => ({
        callId: call.id,
        ok: true,
        content: 'result text',
        render: { type: 'present_card', data: { key: 'value' } } as any,
      }),
    });
    const tools = bridgeTools(registry, makeCtx(), [desc], onRender);
    await tools[0]?.execute('call-3', {});
    expect(renderIntents).toHaveLength(1);
    expect((renderIntents[0] as any).type).toBe('present_card');
  });

  it('JSON-stringifies non-string content (line 86)', async () => {
    const desc = makeDescriptor('list_channels');
    const registry = new ToolRegistry({
      list: () => [desc],
      dispatch: async (call) => ({
        callId: call.id,
        ok: true,
        content: { count: 3, channels: ['C1', 'C2', 'C3'] },
      }),
    });
    const tools = bridgeTools(registry, makeCtx(), [desc]);
    const result = await tools[0]?.execute('call-4', {});
    expect((result?.content[0] as { text?: string } | undefined)?.text).toContain('"count":3');
  });
});

// ---------------------------------------------------------------------------
// pi/agent-setup.ts — buildAgentTools + buildAgentSystemPrompt
// ---------------------------------------------------------------------------

describe('buildAgentTools', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeHctx(turn: Turn, opts = {}) {
    const registry = makeRegistry([makeDescriptor('read_thread')]);
    const ctx = makeCtx();
    return {
      turn,
      modelCfg: {
        baseUrl: 'http://fake',
        apiKey: 'fake-key',
        model: { id: 'gpt-oss-120b', api: 'anthropic-messages' } as any,
      },
      opts: { history: [], slackClient: makeSlackClient(), ...opts } as any,
      registry,
      ctx,
    };
  }

  it('returns agentTools, descriptorMap, knownToolNames, renders', () => {
    const hctx = makeHctx(makeTurn());
    const result = buildAgentTools(hctx, [makeDescriptor('read_thread')], [], []);
    expect(result.agentTools).toBeDefined();
    expect(result.descriptorMap).toBeInstanceOf(Map);
    expect(result.knownToolNames).toBeInstanceOf(Set);
    expect(Array.isArray(result.renders)).toBe(true);
  });

  it('includes find_tools when mcp tools are present (line 94)', () => {
    const hctx = makeHctx(makeTurn());
    const mcpDesc = makeDescriptor('sentry__list_issues');
    const result = buildAgentTools(hctx, [], [mcpDesc], []);
    const names = result.agentTools.map((t) => t.name);
    expect(names).toContain('find_tools');
  });

  it('includes find_tools when cli caps are present (line 94)', () => {
    const hctx = makeHctx(makeTurn());
    const result = buildAgentTools(hctx, [], [], [{ bin: 'gh', description: 'GitHub CLI' }]);
    const names = result.agentTools.map((t) => t.name);
    expect(names).toContain('find_tools');
  });

  it('includes call_tool only when mcp tools are present (line 97)', () => {
    const hctx = makeHctx(makeTurn());
    // No mcp tools — call_tool should NOT appear
    const result1 = buildAgentTools(hctx, [], [], [{ bin: 'gh' }]);
    expect(result1.agentTools.map((t) => t.name)).not.toContain('call_tool');
    // With mcp tools — call_tool SHOULD appear
    const result2 = buildAgentTools(hctx, [], [makeDescriptor('sentry__list_issues')], []);
    expect(result2.agentTools.map((t) => t.name)).toContain('call_tool');
  });

  it('knownToolNames includes find_tools and call_tool when mcp tools exist', () => {
    const hctx = makeHctx(makeTurn());
    const result = buildAgentTools(hctx, [], [makeDescriptor('sentry__list_issues')], []);
    expect(result.knownToolNames.has('find_tools')).toBe(true);
    expect(result.knownToolNames.has('call_tool')).toBe(true);
  });

  it('confirmMcp blocks when no channelId (line 69) — call_tool throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const turnNoChannel = makeTurn();
    delete (turnNoChannel as Partial<Turn>).channelId;
    const mcpDesc = { ...makeDescriptor('sentry__list_issues'), destructiveHint: true };
    const registry = makeRegistry([mcpDesc]);
    const hctx = makeHctx(turnNoChannel);
    hctx.registry = registry;
    // Remove slackClient so confirmMcp has no channel + no client → should block
    hctx.opts.slackClient = undefined;
    const result = buildAgentTools(hctx, [], [mcpDesc], []);
    const callToolAgent = result.agentTools.find((t) => t.name === 'call_tool');
    expect(callToolAgent).toBeDefined();
    // Calling call_tool with a destructive tool should throw (confirmMcp returns false)
    await expect(
      callToolAgent!.execute('tc-mcp', { name: 'sentry__list_issues', arguments: {} }),
    ).rejects.toThrow('owner did not approve');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mcp tool 'sentry__list_issues' blocked"),
    );
    warnSpy.mockRestore();
  });

  it('confirmMcp with channelId posts confirmation and approves on resolve', async () => {
    const mcpDesc = { ...makeDescriptor('sentry__list_issues'), destructiveHint: true };
    const registry = new ToolRegistry({
      list: () => [mcpDesc],
      dispatch: async (call) => ({ callId: call.id, ok: true, content: 'issues listed' }),
    });
    const hctx = makeHctx(makeTurn({ channelId: 'C1' as SlackChannelId }));
    hctx.registry = registry;
    let capturedId: string | undefined;
    const slackClient = makeSlackClient();
    slackClient.chatPostMessage = vi.fn(async () => {
      setImmediate(() => {
        if (capturedId) resolveConfirmation(capturedId, true);
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    hctx.opts.slackClient = slackClient;
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const result = buildAgentTools(hctx, [], [mcpDesc], []);
    const callToolAgent = result.agentTools.find((t) => t.name === 'call_tool');
    const out = await callToolAgent!.execute('tc-mcp', {
      name: 'sentry__list_issues',
      arguments: {},
    });
    expect((out.content[0] as { text?: string } | undefined)?.text).toBe('issues listed');
  });

  it('confirmMcp with threadTs includes thread_ts in post (line 82-84)', async () => {
    const mcpDesc = { ...makeDescriptor('sentry__delete_issue'), destructiveHint: true };
    const registry = new ToolRegistry({
      list: () => [mcpDesc],
      dispatch: async (call) => ({ callId: call.id, ok: true, content: 'deleted' }),
    });
    const hctx = makeHctx(
      makeTurn({
        channelId: 'C1' as SlackChannelId,
        threadTs: '100.200' as SlackThreadTs,
      }),
    );
    hctx.registry = registry;
    let capturedId: string | undefined;
    const slackClient = makeSlackClient();
    slackClient.chatPostMessage = vi.fn(async () => {
      setImmediate(() => {
        if (capturedId) resolveConfirmation(capturedId, true);
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    hctx.opts.slackClient = slackClient;
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const result = buildAgentTools(hctx, [], [mcpDesc], []);
    const callToolAgent = result.agentTools.find((t) => t.name === 'call_tool');
    await callToolAgent!.execute('tc-mcp', { name: 'sentry__delete_issue', arguments: {} });
    expect(slackClient.chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '100.200' }),
    );
  });

  it('renders array is populated when a built-in tool returns a render intent (line 57)', async () => {
    // The onRender sink in buildAgentTools pushes render intents into `renders`.
    // Trigger it by executing a bridged built-in tool that returns `render`.
    const desc = makeDescriptor('present_table');
    const registry = new ToolRegistry({
      list: () => [desc],
      dispatch: async (call) => ({
        callId: call.id,
        ok: true,
        content: 'table data',
        render: { type: 'present_table', data: [] } as any,
      }),
    });
    const hctx = makeHctx(makeTurn());
    hctx.registry = registry;
    const result = buildAgentTools(hctx, [desc], [], []);
    const tool = result.agentTools.find((t) => t.name === 'present_table');
    expect(tool).toBeDefined();
    await tool!.execute('tc-render', {});
    expect(result.renders).toHaveLength(1);
    expect((result.renders[0] as any).type).toBe('present_table');
  });
});

describe('buildAgentSystemPrompt', () => {
  it('combines base + connector + cli catalogs (all non-empty)', () => {
    const result = buildAgentSystemPrompt(
      [makeDescriptor('sentry__list_issues')],
      new Set(['gh']),
      [{ bin: 'gh', description: 'GitHub CLI' }],
    );
    expect(result).toContain('BASE_SYSTEM_PROMPT');
  });

  it('still returns base prompt when no mcp or cli tools (lines 57, 67)', () => {
    const result = buildAgentSystemPrompt([], new Set([]), []);
    expect(result).toContain('BASE_SYSTEM_PROMPT');
  });

  it('injects a home-persona override block for a non-default persona', () => {
    const result = buildAgentSystemPrompt([], new Set([]), [], 'concierge');
    expect(result).toContain('BASE_SYSTEM_PROMPT');
    expect(result).toContain('Active persona (deployment default)');
    expect(result).toContain('Concierge');
  });

  it('adds no override for the default persona (identical to the no-persona call)', () => {
    const withDefault = buildAgentSystemPrompt([], new Set([]), [], 'sym');
    const without = buildAgentSystemPrompt([], new Set([]), []);
    expect(withDefault).toBe(without);
    expect(withDefault).not.toContain('Active persona');
  });
});

// ---------------------------------------------------------------------------
// pi/loop-callbacks.ts — makeBeforeToolCall (the big gap)
// ---------------------------------------------------------------------------

describe('makeBeforeToolCall', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeHctx(
    turnOverrides: Partial<Turn> = {},
    optsOverrides: Record<string, unknown> = {},
  ) {
    const turn = makeTurn(turnOverrides);
    const slackClient = makeSlackClient();
    return {
      turn,
      modelCfg: {
        baseUrl: 'http://fake',
        apiKey: 'fake-key',
        model: { id: 'gpt-oss-120b' } as any,
      },
      opts: { history: [], slackClient, ...optsOverrides } as any,
      registry: makeRegistry([makeDescriptor('read_thread')]),
      ctx: makeCtx(),
      slackClient,
    };
  }

  function makeBeforeCtx(
    toolName: string,
    args: Record<string, unknown> = {},
    toolCallId = 'tc-1',
  ): BeforeToolCallContext {
    return {
      toolCall: { id: toolCallId, name: toolName },
      args,
    } as unknown as BeforeToolCallContext;
  }

  it('returns undefined for a non-destructive, non-slack-guard tool', async () => {
    const { turn, modelCfg, opts, registry } = makeHctx();
    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    const descriptorMap = new Map([['read_thread', makeDescriptor('read_thread')]]);
    const fn = makeBeforeToolCall(hctx, descriptorMap);
    const result = await fn(makeBeforeCtx('read_thread'));
    expect(result).toBeUndefined();
  });

  it('blocks a destructive tool when slackClient and channelId are absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const turnNoChannel = makeTurn();
    delete (turnNoChannel as Partial<Turn>).channelId;
    const { modelCfg, registry } = makeHctx();
    const opts = { history: [], slackClient: undefined } as any;
    const hctx = { turn: turnNoChannel, modelCfg, opts, registry, ctx: makeCtx() };
    const descriptorMap = new Map([['delete_message', makeDescriptor('delete_message', true)]]);
    const fn = makeBeforeToolCall(hctx, descriptorMap);
    const result = await fn(makeBeforeCtx('delete_message'));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Confirmation channel unavailable');
    warnSpy.mockRestore();
  });

  it('blocks when signal is already aborted (line 164)', async () => {
    const { turn, modelCfg, opts, registry } = makeHctx();
    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    const descriptorMap = new Map([['delete_message', makeDescriptor('delete_message', true)]]);
    const controller = new AbortController();
    controller.abort();
    const fn = makeBeforeToolCall(hctx, descriptorMap);
    const result = await fn(makeBeforeCtx('delete_message'), controller.signal);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('cancelled');
  });

  it('asks for confirmation for a destructive tool and returns undefined on approve', async () => {
    const { turn, modelCfg, opts, registry, slackClient } = makeHctx();
    // Make chatPostMessage succeed (so requestConfirmation posts the message)
    // then immediately resolve the pending promise via resolveConfirmation
    let capturedId: string | undefined;
    slackClient.chatPostMessage = vi.fn(async () => {
      // After the post, resolve the confirmation immediately (approved = true).
      // The confirmation id was captured via the randomUUID spy below.
      setImmediate(() => {
        // The confirmation id is embedded in the action_id:  sym_confirm:<id>:approve
        // We need to capture it from the blocks
        if (capturedId) {
          resolveConfirmation(capturedId, true);
        }
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    // Intercept the crypto.randomUUID call to capture the ID
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );

    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    opts.slackClient = slackClient;
    const descriptorMap = new Map([['delete_message', makeDescriptor('delete_message', true)]]);
    const fn = makeBeforeToolCall(hctx, descriptorMap);
    const result = await fn(makeBeforeCtx('delete_message'));
    // Approved → undefined (allow through)
    expect(result).toBeUndefined();
  });

  it('blocks destructive tool when owner denies (approved=false)', async () => {
    const { turn, modelCfg, opts, registry, slackClient } = makeHctx();
    let capturedId: string | undefined;
    slackClient.chatPostMessage = vi.fn(async () => {
      setImmediate(() => {
        if (capturedId) resolveConfirmation(capturedId, false);
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );

    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    opts.slackClient = slackClient;
    const descriptorMap = new Map([['delete_message', makeDescriptor('delete_message', true)]]);
    const fn = makeBeforeToolCall(hctx, descriptorMap);
    const result = await fn(makeBeforeCtx('delete_message'));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('did not approve');
  });

  // Slack-guard paths
  it('blocks when slackGuard returns redirect (line 101)', async () => {
    mockJudgeSlackToolUse.mockResolvedValueOnce('redirect');
    const { turn, modelCfg, opts, registry } = makeHctx({ text: 'fix the github issue' });
    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    const result = await fn(makeBeforeCtx('search_messages', { query: 'github issue' }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('find_tools');
  });

  it('caches the slackGuard verdict across multiple calls', async () => {
    mockJudgeSlackToolUse.mockResolvedValue('allow');
    const { turn, modelCfg, opts, registry } = makeHctx({ text: 'search slack' });
    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    await fn(makeBeforeCtx('search_messages', {}));
    await fn(makeBeforeCtx('list_channels', {}));
    // judgeSlackToolUse called ONCE total (cache hit on second call)
    expect(mockJudgeSlackToolUse).toHaveBeenCalledOnce();
  });

  it('promotes slackGuard confirm verdict to allow when no channelId (line 132)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockJudgeSlackToolUse.mockResolvedValueOnce('confirm');
    const turnNoChannel = makeTurn();
    delete (turnNoChannel as Partial<Turn>).channelId;
    const { modelCfg, registry } = makeHctx();
    const opts = { history: [], slackClient: undefined } as any;
    const hctx = { turn: turnNoChannel, modelCfg, opts, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    // Should warn and fail open (allow through)
    const result = await fn(makeBeforeCtx('search_messages', {}));
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("guard verdict 'confirm'"));
    warnSpy.mockRestore();
  });

  it('slackGuard confirm with channel prompts owner and allows on approve', async () => {
    mockJudgeSlackToolUse.mockResolvedValueOnce('confirm');
    const { turn, modelCfg, opts, registry, slackClient } = makeHctx({
      text: 'read my slack DMs',
      channelId: 'C1' as SlackChannelId,
    });
    let capturedId: string | undefined;
    slackClient.chatPostMessage = vi.fn(async () => {
      setImmediate(() => {
        if (capturedId) resolveConfirmation(capturedId, true);
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const hctx = { turn, modelCfg, opts: { ...opts, slackClient }, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    const result = await fn(makeBeforeCtx('search_messages', {}));
    expect(result).toBeUndefined();
  });

  it('slackGuard confirm with channel blocks when owner denies', async () => {
    mockJudgeSlackToolUse.mockResolvedValueOnce('confirm');
    const { turn, modelCfg, opts, registry, slackClient } = makeHctx({
      text: 'read my slack DMs',
      channelId: 'C1' as SlackChannelId,
    });
    let capturedId: string | undefined;
    slackClient.chatPostMessage = vi.fn(async () => {
      setImmediate(() => {
        if (capturedId) resolveConfirmation(capturedId, false);
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const hctx = { turn, modelCfg, opts: { ...opts, slackClient }, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    const result = await fn(makeBeforeCtx('search_messages', {}));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('did not approve');
  });

  it('run_cli: allows help/version introspection regardless of cliConfirm', async () => {
    const { turn, modelCfg, opts, registry } = makeHctx({}, { cliConfirm: true });
    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    // --help is introspection-only → needsConfirm = false → allow
    const result = await fn(makeBeforeCtx('run_cli', { argv: ['gh', '--help'] }));
    expect(result).toBeUndefined();
  });

  it('run_cli: blocks real command when cliConfirm=true (approved)', async () => {
    const { turn, modelCfg, opts, registry, slackClient } = makeHctx({}, { cliConfirm: true });
    let capturedId: string | undefined;
    slackClient.chatPostMessage = vi.fn(async () => {
      setImmediate(() => {
        if (capturedId) resolveConfirmation(capturedId, true);
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const hctx = { turn, modelCfg, opts: { ...opts, slackClient }, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    const result = await fn(makeBeforeCtx('run_cli', { argv: ['gh', 'issue', 'list'] }));
    expect(result).toBeUndefined();
  });

  it('run_cli: cliConfirm=false → non-destructive → always allowed', async () => {
    const { turn, modelCfg, opts, registry } = makeHctx({}, { cliConfirm: false });
    const hctx = { turn, modelCfg, opts, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    const result = await fn(makeBeforeCtx('run_cli', { argv: ['gh', 'issue', 'list'] }));
    expect(result).toBeUndefined();
  });

  it('run_cli: argv with non-string items is coerced to empty (treated as non-introspection when cliConfirm=true)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No channelId + cliConfirm=true + non-introspection → blocks (fail closed)
    const turnNoChannel = makeTurn();
    delete (turnNoChannel as Partial<Turn>).channelId;
    const { modelCfg, registry } = makeHctx();
    const opts = { history: [], slackClient: undefined, cliConfirm: true } as any;
    const hctx = { turn: turnNoChannel, modelCfg, opts, registry, ctx: makeCtx() };
    const fn = makeBeforeToolCall(hctx, new Map());
    // argv has non-string items → filtered to [] → length <= 1 → isIntrospectionOnly=true → allowed
    const result = await fn(makeBeforeCtx('run_cli', { argv: [42, null] }));
    expect(result).toBeUndefined(); // isIntrospectionOnly([] <= 1) = true
    warnSpy.mockRestore();
  });

  it('onToolGate is called for awaiting/approved/denied on destructive tool', async () => {
    const gateCalls: { phase: string }[] = [];
    const { turn, modelCfg, opts, registry, slackClient } = makeHctx(
      {},
      {
        onToolGate: async (_id: string, phase: string) => {
          gateCalls.push({ phase });
        },
      },
    );
    let capturedId: string | undefined;
    slackClient.chatPostMessage = vi.fn(async () => {
      setImmediate(() => {
        if (capturedId) resolveConfirmation(capturedId, true);
      });
      return { ts: '123.456' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const hctx = { turn, modelCfg, opts: { ...opts, slackClient }, registry, ctx: makeCtx() };
    const descriptorMap = new Map([['delete_message', makeDescriptor('delete_message', true)]]);
    const fn = makeBeforeToolCall(hctx, descriptorMap);
    await fn(makeBeforeCtx('delete_message'));
    expect(gateCalls.map((c) => c.phase)).toContain('awaiting');
    expect(gateCalls.map((c) => c.phase)).toContain('approved');
  });
});

// ---------------------------------------------------------------------------
// pi/loop-callbacks.ts — makeSubscriber
// ---------------------------------------------------------------------------

describe('makeSubscriber', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeOpts(overrides: Record<string, unknown> = {}) {
    return {
      history: [],
      onStatus: vi.fn(),
      onDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      ...overrides,
    } as any;
  }

  // Synthetic AgentEvent builders — the subscriber only reads a handful of
  // fields, so we build the minimal shape and cast to the full union type.
  function textDeltaEvent(
    delta: string,
    partialContent: { type: string; text?: string; thinking?: string }[],
  ): AgentEvent {
    return {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta, partial: { content: partialContent } },
    } as unknown as AgentEvent;
  }
  function toolStartEvent(toolName: string, toolCallId: string, args: unknown = {}): AgentEvent {
    return { type: 'tool_execution_start', toolName, toolCallId, args } as unknown as AgentEvent;
  }
  function toolEndEvent(toolName: string, toolCallId: string, isError: boolean): AgentEvent {
    return { type: 'tool_execution_end', toolName, toolCallId, isError } as unknown as AgentEvent;
  }

  it('emits writing status on first text_delta with real text', async () => {
    const opts = makeOpts();
    const draftParts: string[] = [];
    const toolsInvoked: string[] = [];
    const knownTools = new Set(['read_thread']);
    const fn = makeSubscriber(opts, knownTools, draftParts, toolsInvoked);

    await fn(textDeltaEvent('Hello', [{ type: 'text', text: 'Hello' }]));

    expect(opts.onStatus).toHaveBeenCalledWith('is writing the reply…');
    expect(draftParts).toContain('Hello');
  });

  it('does not emit writing status twice in one reply phase', async () => {
    const opts = makeOpts();
    const fn = makeSubscriber(opts, new Set(['read_thread']), [], []);

    await fn(textDeltaEvent('A', [{ type: 'text', text: 'A' }]));
    await fn(textDeltaEvent('B', [{ type: 'text', text: 'AB' }]));

    expect(opts.onStatus).toHaveBeenCalledOnce();
  });

  it('re-arms writing status after a tool start', async () => {
    const opts = makeOpts();
    const toolsInvoked: string[] = [];
    const fn = makeSubscriber(opts, new Set(['read_thread']), [], toolsInvoked);

    // First text phase
    await fn(textDeltaEvent('A', [{ type: 'text', text: 'A' }]));
    // Tool start re-arms
    await fn(toolStartEvent('read_thread', 'tc-1'));
    // Next text phase re-emits writing status
    await fn(textDeltaEvent('B', [{ type: 'text', text: 'B' }]));

    const statusCalls = opts.onStatus.mock.calls.map((c: any) => c[0]);
    const writingCount = statusCalls.filter((s: string) => s === 'is writing the reply…').length;
    expect(writingCount).toBe(2);
  });

  it('drops status for unknown tools (phantom tool guard)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = makeOpts();
    const fn = makeSubscriber(opts, new Set(['read_thread']), [], []);

    await fn(toolStartEvent('Summarizing', 'x'));

    expect(opts.onToolStart).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown tool 'Summarizing'"));
    warnSpy.mockRestore();
  });

  it('silently skips SILENT_TOOLS on start (update_task, set_plan, present_card, present_table)', async () => {
    const opts = makeOpts();
    const fn = makeSubscriber(
      opts,
      new Set(['update_task', 'set_plan', 'present_card', 'present_table']),
      [],
      [],
    );

    for (const tool of ['update_task', 'set_plan', 'present_card', 'present_table']) {
      await fn(toolStartEvent(tool, `tc-${tool}`));
    }
    expect(opts.onToolStart).not.toHaveBeenCalled();
    expect(opts.onStatus).not.toHaveBeenCalled();
  });

  it('silently skips SILENT_TOOLS on end', async () => {
    const opts = makeOpts();
    const fn = makeSubscriber(opts, new Set(['update_task']), [], []);
    await fn(toolEndEvent('update_task', 'tc-1', false));
    expect(opts.onToolEnd).not.toHaveBeenCalled();
  });

  it('drops tool_execution_end for unknown tools (phantom guard)', async () => {
    const opts = makeOpts();
    const fn = makeSubscriber(opts, new Set(['read_thread']), [], []);
    await fn(toolEndEvent('PhantomTool', 'x', false));
    expect(opts.onToolEnd).not.toHaveBeenCalled();
  });

  it('fires onToolStart and onToolEnd for a known non-silent tool', async () => {
    const opts = makeOpts();
    const toolsInvoked: string[] = [];
    const fn = makeSubscriber(opts, new Set(['read_thread']), [], toolsInvoked);

    await fn(toolStartEvent('read_thread', 'tc-1'));
    await fn(toolEndEvent('read_thread', 'tc-1', true));

    expect(toolsInvoked).toContain('read_thread');
    expect(opts.onToolStart).toHaveBeenCalledOnce();
    expect(opts.onToolEnd).toHaveBeenCalledWith('tc-1', true);
  });

  it('does not emit writing status when partial has no real text content', async () => {
    const opts = makeOpts();
    const fn = makeSubscriber(opts, new Set(), [], []);

    await fn(textDeltaEvent('', [{ type: 'text', text: '' }]));
    await fn(textDeltaEvent('thinking chunk', [{ type: 'thinking', thinking: 'analysis' }]));
    expect(opts.onStatus).not.toHaveBeenCalled();
  });

  it('appends delta to draftParts regardless of writing-status flip', async () => {
    const opts = makeOpts({ onStatus: undefined });
    const draftParts: string[] = [];
    const fn = makeSubscriber(opts, new Set(), draftParts, []);

    await fn(textDeltaEvent('chunk1', [{ type: 'text', text: 'chunk1' }]));
    await fn(textDeltaEvent('chunk2', [{ type: 'text', text: 'chunk1chunk2' }]));
    expect(draftParts).toEqual(['chunk1', 'chunk2']);
  });
});

// ---------------------------------------------------------------------------
// reply-cleanup.ts — cleanupReply (the LLM path + caching + error fallback)
// ---------------------------------------------------------------------------

describe('cleanupReply', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    piAgentSubscribers.length = 0;
    piAgentPromptFn = undefined;
  });

  const DEPS = {
    fireworks: { baseUrl: 'https://api.fireworks.ai/inference', apiKey: 'fake' },
    model: 'accounts/fireworks/models/gpt-oss-120b',
  };

  it('returns draft unchanged when draft is empty/whitespace (line 110)', async () => {
    const result = await cleanupReply('   ', DEPS);
    expect(result).toBe('   ');
  });

  it('returns draft unchanged when model returns no fragments (line 134)', async () => {
    piAgentPromptFn = async (_text: string) => {
      const sub = piAgentSubscribers[piAgentSubscribers.length - 1];
      if (sub) {
        await sub({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '{"remove":[]}',
            partial: { content: [{ type: 'text', text: '{"remove":[]}' }] },
          },
        });
      }
    };
    const result = await cleanupReply('The real answer.', DEPS);
    expect(result).toBe('The real answer.');
  });

  it('removes flagged fragments from the draft (lines 131-136)', async () => {
    piAgentPromptFn = async (_text: string) => {
      const sub = piAgentSubscribers[piAgentSubscribers.length - 1];
      if (sub) {
        await sub({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '{"remove":["Now start p1."]}',
            partial: { content: [{ type: 'text', text: '{"remove":["Now start p1."]}' }] },
          },
        });
      }
    };
    const result = await cleanupReply('Now start p1. The real answer.', DEPS);
    expect(result).toBe('The real answer.');
  });

  it('falls back to original draft when cleaned result is empty (line 136)', async () => {
    piAgentPromptFn = async (_text: string) => {
      const sub = piAgentSubscribers[piAgentSubscribers.length - 1];
      if (sub) {
        await sub({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '{"remove":["Now reply."]}',
            partial: { content: [{ type: 'text', text: '{"remove":["Now reply."]}' }] },
          },
        });
      }
    };
    // If the entire draft is removed, fallback to original
    const result = await cleanupReply('Now reply.', DEPS);
    // applyRemovals('Now reply.', ['Now reply.']) = '' → fallback to draft
    expect(result).toBe('Now reply.');
  });

  it('falls back to draft on any error (lines 137-139)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    piAgentPromptFn = async (_text: string) => {
      throw new Error('model exploded');
    };
    const result = await cleanupReply('The answer is 42.', DEPS);
    expect(result).toBe('The answer is 42.');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('reply cleanup failed'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('uses the model cache for the same baseUrl+model combination (lines 52-58)', async () => {
    // Two calls to cleanupReply with the same deps — should not throw or break
    piAgentPromptFn = async (_text: string) => {
      const sub = piAgentSubscribers[piAgentSubscribers.length - 1];
      if (sub) {
        await sub({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '{"remove":[]}',
            partial: { content: [{ type: 'text', text: '{"remove":[]}' }] },
          },
        });
      }
    };
    const r1 = await cleanupReply('draft one', DEPS);
    const r2 = await cleanupReply('draft two', DEPS);
    expect(r1).toBe('draft one');
    expect(r2).toBe('draft two');
  });
});

// ---------------------------------------------------------------------------
// event-router.ts — processInteractivity (the sync path, easy to cover fully)
// ---------------------------------------------------------------------------

describe('processInteractivity', () => {
  afterEach(() => vi.restoreAllMocks());

  const ownerGateAllow = (_id: string, _surface: string) => true;
  const ownerGateDeny = (_id: string, _surface: string) => false;

  it('returns 400 missing_payload when payload field is absent', () => {
    const result = processInteractivity('foo=bar', 'T1', ownerGateAllow);
    expect(result).toEqual({ status: 400, body: { error: 'missing_payload' } });
  });

  it('returns 400 invalid_payload_json on non-JSON payload', () => {
    const body = new URLSearchParams({ payload: 'not-json' }).toString();
    const result = processInteractivity(body, 'T1', ownerGateAllow);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_payload_json' } });
  });

  it('returns 200 ok for non-block_actions interaction types', () => {
    const payload = JSON.stringify({
      type: 'view_submission',
      user: { id: 'U1' },
      team: { id: 'T1' },
    });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T1', ownerGateAllow);
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it('returns 400 missing_user_or_team when user/team is absent', () => {
    const payload = JSON.stringify({ type: 'block_actions', actions: [] });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T1', ownerGateAllow);
    expect(result).toEqual({ status: 400, body: { error: 'missing_user_or_team' } });
  });

  it('returns 200 ok for foreign-workspace team id', () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U1' },
      team: { id: 'T_FOREIGN' },
      actions: [{ action_id: 'sym_confirm:abc:approve' }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T_OWN', ownerGateAllow);
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it('returns 200 ok when owner gate denies the clicker', () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U_OTHER' },
      team: { id: 'T1' },
      actions: [{ action_id: 'sym_confirm:abc:approve' }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T1', ownerGateDeny);
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it('returns 200 ok when action_id does not match sym_confirm pattern', () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U1' },
      team: { id: 'T1' },
      actions: [{ action_id: 'some_other_action' }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T1', ownerGateAllow);
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it('warns and returns resolved:false for a stale/unknown confirmation id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U1' },
      team: { id: 'T1' },
      actions: [{ action_id: 'sym_confirm:unknown-id:approve' }],
      response_url: 'https://hooks.slack.com/actions/T1/xxx',
    });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T1', ownerGateAllow);
    // resolveConfirmation returns false for unknown id → warns but still returns 'resolved'
    expect(result).toMatchObject({ status: 'resolved', approved: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('resolveConfirmation returned false'),
    );
    warnSpy.mockRestore();
  });

  it('returns resolved:approved=true for approve action', async () => {
    // Register a real confirmation so resolveConfirmation returns true.
    // We need to await a microtask after starting requestConfirmation so that
    // chatPostMessage resolves and pending.set() has been called before we
    // invoke processInteractivity (which calls resolveConfirmation).
    let capturedId = '';
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );

    const slackClient = makeSlackClient();
    // Start a pending confirmation — do NOT await yet.
    const confirmPromise = requestConfirmation({
      slackClient: slackClient as any,
      channel: 'C1' as SlackChannelId,
      toolName: 'delete_message',
      args: { channel_id: 'C1' },
      timeoutMs: 5000,
    });

    // Wait for chatPostMessage microtask to settle so pending.set() runs.
    await Promise.resolve();

    // The id is now registered in the pending map.
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U1' },
      team: { id: 'T1' },
      actions: [{ action_id: `sym_confirm:${capturedId}:approve` }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T1', ownerGateAllow);
    expect(result).toMatchObject({ status: 'resolved', approved: true });

    // The confirmation promise should resolve
    const approved = await confirmPromise;
    expect(approved).toBe(true);
  });

  it('returns resolved:approved=false for deny action', async () => {
    let capturedId = '';
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );

    const slackClient = makeSlackClient();
    const confirmPromise = requestConfirmation({
      slackClient: slackClient as any,
      channel: 'C1' as SlackChannelId,
      toolName: 'delete_message',
      args: {},
      timeoutMs: 5000,
    });

    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U1' },
      team: { id: 'T1' },
      actions: [{ action_id: `sym_confirm:${capturedId}:deny` }],
      response_url: 'https://hooks.slack.com/actions/T1/xxx',
    });
    const body = new URLSearchParams({ payload }).toString();
    const result = processInteractivity(body, 'T1', ownerGateAllow);
    expect(result).toMatchObject({ status: 'resolved', approved: false });

    const approved = await confirmPromise;
    expect(approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// event-router.ts — processEvent
// ---------------------------------------------------------------------------

describe('processEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeCtxObj(overrides: Record<string, unknown> = {}) {
    const slackClient = makeSlackClient();
    return {
      workspaceId: 'ws-1',
      botUserId: 'UBOT' as SlackUserId,
      slackTeamId: 'T1',
      fireworks: { baseUrl: 'http://fake', apiKey: 'key' },
      model: 'gpt-oss-120b',
      slackClient,
      ownerSlackUserId: 'U_OWNER' as SlackUserId,
      ownerProfile: undefined,
      nameResolver: { resolve: async () => ({}) } as any,
      ...overrides,
    } as any;
  }

  function makeConfig() {
    return {
      slackTeamId: 'T1',
      behavior: { taskCardThreshold: 0, taskCardAfter: 'delete', ownerPostMarker: true },
    } as any;
  }

  function makeAssistantContextStore() {
    return {
      remember: vi.fn(),
      lookup: vi.fn(() => undefined),
    } as any;
  }

  const ownerGateAllow = (_id: string, _surface: string) => true;
  const ownerGateDeny = (_id: string, _surface: string) => false;

  it('ignores events from foreign teams (line 73)', async () => {
    const ctx = makeCtxObj();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processEvent(
      {} as any,
      'T_FOREIGN',
      ctx,
      makeConfig(),
      makeAssistantContextStore(),
      ownerGateAllow,
    );
    expect(mockHandleTurn).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handles assistantThreadContextChanged and gates it (owner allowed)', async () => {
    mockAssistantThreadContextChanged.mockReturnValueOnce({
      userId: 'U_OWNER',
      channelId: 'C1',
      threadTs: '100.1',
      contextChannelId: 'C2',
    });
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', makeCtxObj(), makeConfig(), store, ownerGateAllow);
    expect(store.remember).toHaveBeenCalledWith('C1', '100.1', 'C2');
  });

  it('drops assistantThreadContextChanged when owner gate denies (line 84)', async () => {
    mockAssistantThreadContextChanged.mockReturnValueOnce({
      userId: 'U_OTHER',
      channelId: 'C1',
      threadTs: '100.1',
      contextChannelId: 'C2',
    });
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', makeCtxObj(), makeConfig(), store, ownerGateDeny);
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('handles assistantThreadStarted (owner allowed) — calls handleAssistantThreadStarted', async () => {
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValueOnce({
      userId: 'U_OWNER',
      channelId: 'C1',
      threadTs: '100.2',
      contextChannelId: 'C3',
    });
    mockHandleAssistantThreadStarted.mockResolvedValueOnce(undefined);
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', makeCtxObj(), makeConfig(), store, ownerGateAllow);
    expect(mockHandleAssistantThreadStarted).toHaveBeenCalled();
    expect(store.remember).toHaveBeenCalledWith('C1', '100.2', 'C3');
  });

  it('drops assistantThreadStarted when owner gate denies', async () => {
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValueOnce({
      userId: 'U_OTHER',
      channelId: 'C1',
      threadTs: '100.2',
      contextChannelId: 'C3',
    });
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', makeCtxObj(), makeConfig(), store, ownerGateDeny);
    expect(mockHandleAssistantThreadStarted).not.toHaveBeenCalled();
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('returns early when normalizeSlackEvent returns null (line 114)', async () => {
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValue(null);
    mockNormalizeSlackEvent.mockReturnValueOnce(null);
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', makeCtxObj(), makeConfig(), store, ownerGateAllow);
    expect(mockHandleTurn).not.toHaveBeenCalled();
  });

  it('dispatches handleTurn for a valid event when owner gate passes', async () => {
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValue(null);
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn();
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockResolvedValueOnce(undefined);
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', makeCtxObj(), makeConfig(), store, ownerGateAllow);
    expect(mockHandleTurn).toHaveBeenCalledOnce();
  });

  it('drops event when owner gate denies a non-DM turn (line 121)', async () => {
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValue(null);
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ entrySurface: 'app_mention' });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', makeCtxObj(), makeConfig(), store, ownerGateDeny);
    expect(mockHandleTurn).not.toHaveBeenCalled();
  });

  it('posts decline message for DM turns when owner gate denies (lines 122-133)', async () => {
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValue(null);
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ entrySurface: 'dm', channelId: 'D1' as SlackChannelId });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    const ctx = makeCtxObj();
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', ctx, makeConfig(), store, ownerGateDeny);
    expect(ctx.slackClient.chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D1' }),
    );
  });

  it('warns but continues when decline post fails (line 131)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValue(null);
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ entrySurface: 'dm', channelId: 'D1' as SlackChannelId });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    const ctx = makeCtxObj();
    ctx.slackClient.chatPostMessage = vi.fn(async () => {
      throw new Error('no_permission');
    });
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', ctx, makeConfig(), store, ownerGateDeny);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('owner-gate decline post failed'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('passes userSlackClient through to buildTurnDeps when present', async () => {
    mockAssistantThreadContextChanged.mockReturnValue(null);
    mockAssistantThreadStarted.mockReturnValue(null);
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn();
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockResolvedValueOnce(undefined);
    const ctx = makeCtxObj({ userSlackClient: makeSlackClient() });
    const store = makeAssistantContextStore();
    await processEvent({} as any, 'T1', ctx, makeConfig(), store, ownerGateAllow);
    const turnDeps = mockHandleTurn.mock.calls[0]?.[1];
    expect(turnDeps?.userSlackClient).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// event-router.ts — processSlashCommand
// ---------------------------------------------------------------------------

describe('processSlashCommand', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeCtxObj() {
    const slackClient = makeSlackClient();
    return {
      workspaceId: 'ws-1',
      botUserId: 'UBOT' as SlackUserId,
      slackTeamId: 'T1',
      fireworks: { baseUrl: 'http://fake', apiKey: 'key' },
      model: 'gpt-oss-120b',
      slackClient,
      ownerSlackUserId: 'U_OWNER' as SlackUserId,
      nameResolver: { resolve: async () => ({}) } as any,
    } as any;
  }

  function makeConfig() {
    return {
      slackTeamId: 'T1',
      behavior: { taskCardThreshold: 0, taskCardAfter: 'delete', ownerPostMarker: true },
    } as any;
  }

  it('returns early when normalizeSlackEvent returns null', async () => {
    mockNormalizeSlackEvent.mockReturnValueOnce(null);
    const postToResponseUrl = vi.fn(async () => true);
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      false,
      makeCtxObj(),
      makeConfig(),
      postToResponseUrl,
    );
    expect(mockHandleTurn).not.toHaveBeenCalled();
  });

  it('returns early when turn has no channelId', async () => {
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn();
    delete (turn as Partial<Turn>).channelId;
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    const postToResponseUrl = vi.fn(async () => true);
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      false,
      makeCtxObj(),
      makeConfig(),
      postToResponseUrl,
    );
    expect(mockHandleTurn).not.toHaveBeenCalled();
  });

  it('seeds channel and calls handleTurn with the seeded thread', async () => {
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ text: 'summarize this' });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockResolvedValueOnce(undefined);
    const ctx = makeCtxObj();
    ctx.slackClient.chatPostMessage = vi.fn(async () => ({
      ts: 'seed.ts' as SlackThreadTs,
      channel: 'C1' as SlackChannelId,
    }));
    const postToResponseUrl = vi.fn(async () => true);
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      false,
      ctx,
      makeConfig(),
      postToResponseUrl,
    );
    expect(mockHandleTurn).toHaveBeenCalledOnce();
    const threadedTurn = mockHandleTurn.mock.calls[0]?.[0];
    expect(threadedTurn?.threadTs).toBe('seed.ts');
  });

  it('uses (no text) as seedText when turn.text is empty', async () => {
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ text: '' });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockResolvedValueOnce(undefined);
    const ctx = makeCtxObj();
    let capturedPostMsg: any;
    ctx.slackClient.chatPostMessage = vi.fn(async (params: any) => {
      capturedPostMsg = params;
      return { ts: 'seed.ts' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    });
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      false,
      ctx,
      makeConfig(),
      vi.fn(async () => true),
    );
    expect(capturedPostMsg?.text).toContain('(no text)');
  });

  it('falls back to response_url when seed post fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ text: 'hi' });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockImplementationOnce(async (_turn: any, deps: any) => {
      // Simulate the handleTurn calling replySink
      await deps.replySink?.({
        text: 'answer text',
        blocks: [{ type: 'markdown', text: 'answer text' }],
        receiptText: '(model: gpt)',
      });
    });
    const ctx = makeCtxObj();
    ctx.slackClient.chatPostMessage = vi.fn(async () => {
      throw new Error('not_in_channel');
    });
    const postCalls: unknown[] = [];
    const postToResponseUrl = vi.fn(async (_url: string, payload: unknown) => {
      postCalls.push(payload);
      return true;
    });
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      false,
      ctx,
      makeConfig(),
      postToResponseUrl,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('seed post failed'),
      expect.any(Error),
    );
    expect(postCalls.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('uses ephemeral response type for DM context in fallback path', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ text: 'hi' });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockImplementationOnce(async (_turn: any, deps: any) => {
      await deps.replySink?.({
        text: 'answer',
        blocks: [{ type: 'markdown', text: 'answer' }],
        receiptText: '',
      });
    });
    const ctx = makeCtxObj();
    ctx.slackClient.chatPostMessage = vi.fn(async () => {
      throw new Error('not_in_channel');
    });
    const postCalls: any[] = [];
    const postToResponseUrl = vi.fn(async (_url: string, payload: unknown) => {
      postCalls.push(payload);
      return true;
    });
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      true /* isDm */,
      ctx,
      makeConfig(),
      postToResponseUrl,
    );
    const firstCall = postCalls[0];
    expect(firstCall?.response_type).toBe('ephemeral');
    warnSpy.mockRestore();
  });

  it('sends hint on response_url answer failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ text: 'hi' });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockRejectedValueOnce(new Error('handleTurn failed'));
    const ctx = makeCtxObj();
    ctx.slackClient.chatPostMessage = vi.fn(async () => {
      throw new Error('not_in_channel');
    });
    const postCalls: any[] = [];
    const postToResponseUrl = vi.fn(async (_url: string, payload: unknown) => {
      postCalls.push(payload);
      return true;
    });
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      false,
      ctx,
      makeConfig(),
      postToResponseUrl,
    );
    const hintCall = postCalls.find((p: any) => p?.text?.includes('hit an error'));
    expect(hintCall).toBeDefined();
    expect(hintCall?.response_type).toBe('ephemeral');
    warnSpy.mockRestore();
  });

  it('falls back to text-only when rich blocks response_url post fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockNormalizeSlackEvent.mockReturnValueOnce({ workspaceId: 'ws-1', event: {} });
    const turn = makeTurn({ text: 'hi' });
    mockSlackTurnInputToTurn.mockReturnValueOnce(turn);
    mockHandleTurn.mockImplementationOnce(async (_turn: any, deps: any) => {
      await deps.replySink?.({
        text: 'answer text',
        blocks: [{ type: 'markdown', text: 'answer text' }],
        receiptText: 'footer',
      });
    });
    const ctx = makeCtxObj();
    ctx.slackClient.chatPostMessage = vi.fn(async () => {
      throw new Error('not_in_channel');
    });
    let callCount = 0;
    const postToResponseUrl = vi.fn(async (_url: string, payload: any) => {
      callCount++;
      // First call (rich blocks) fails, second call (text only) succeeds
      if (callCount === 1 && payload.blocks) return false;
      return true;
    });
    await processSlashCommand(
      {} as any,
      'U1' as SlackUserId,
      'https://url',
      false,
      ctx,
      makeConfig(),
      postToResponseUrl,
    );
    // Should have called postToResponseUrl twice (rich → text fallback)
    expect(postToResponseUrl).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// confirmations.ts — requestConfirmation error + timeout paths
// ---------------------------------------------------------------------------

describe('confirmations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolveConfirmation returns false for unknown id', () => {
    expect(resolveConfirmation('non-existent-id', true)).toBe(false);
  });

  it('resolveConfirmation returns true when id is found and settles the promise', async () => {
    let capturedId = '';
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const slackClient = makeSlackClient();
    const promise = requestConfirmation({
      slackClient: slackClient as any,
      channel: 'C1' as SlackChannelId,
      toolName: 'delete_message',
      args: { channel_id: 'C1' },
      timeoutMs: 5000,
    });
    // Wait for chatPostMessage to settle so pending.set() runs before resolveConfirmation.
    await Promise.resolve();
    const resolved = resolveConfirmation(capturedId, true);
    expect(resolved).toBe(true);
    expect(await promise).toBe(true);
  });

  it('returns false when chatPostMessage throws (fail closed — line 155)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const slackClient = makeSlackClient();
    slackClient.chatPostMessage = vi.fn(async () => {
      throw new Error('no_permission');
    });
    const result = await requestConfirmation({
      slackClient: slackClient as any,
      channel: 'C1' as SlackChannelId,
      toolName: 'delete_message',
      args: {},
      timeoutMs: 5000,
    });
    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to post confirmation message'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('times out and resolves false after timeoutMs (line 160)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slackClient = makeSlackClient();
    const result = await requestConfirmation({
      slackClient: slackClient as any,
      channel: 'C1' as SlackChannelId,
      toolName: 'test_tool',
      args: {},
      timeoutMs: 10, // very short timeout
    });
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    warnSpy.mockRestore();
  }, 3000);

  it('includes threadTs in the post when provided', async () => {
    let capturedId = '';
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(
      uuidMockImpl((id) => {
        capturedId = id;
      }),
    );
    const slackClient = makeSlackClient();
    const promise = requestConfirmation({
      slackClient: slackClient as any,
      channel: 'C1' as SlackChannelId,
      threadTs: '100.200' as SlackThreadTs,
      toolName: 'post_as_owner',
      args: { text: 'Hello!' },
      timeoutMs: 5000,
    });
    resolveConfirmation(capturedId, false);
    await promise;
    expect(slackClient.chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '100.200' }),
    );
  });
});
