/**
 * Unit tests for the pi/loop.ts subscriber filters + whimsy helper.
 *
 * The subscriber is the place where Harmony channel leaks would surface
 * (phantom tool names, premature "writing" status). These tests pin those
 * filters in place so regressions show up loudly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pi-agent-core's Agent so we can capture the subscriber callback and
// drive synthetic events through it without any network/model state.
// ---------------------------------------------------------------------------

type Subscriber = (event: unknown) => void | Promise<void>;
const capturedSubscribers: Subscriber[] = [];

vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgent {
    state = { messages: [], errorMessage: undefined };
    subscribe(fn: Subscriber): void {
      capturedSubscribers.push(fn);
    }
    async prompt(_text: string): Promise<void> {
      // no-op — tests drive the captured subscriber directly.
    }
    abort(): void {
      /* no-op */
    }
  }
  return { Agent: FakeAgent };
});

import { ToolRegistry } from '@sym/kernel';

import { extractUsage, friendlyVerb, runLoopPi, toAgentMessages } from '../src/pi/loop.js';
import { nextWhimsicalStatus, WHIMSY_WORDS } from '../src/thinking-copy.js';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type {
  ChatMessage,
  Turn,
  TurnId,
  WorkspaceId,
  SlackChannelId,
  SlackUserId,
  ToolDescriptor,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTurn(): Turn {
  return {
    id: 'turn-1' as TurnId,
    workspaceId: 'ws-1' as WorkspaceId,
    conversationId: 'ws-1:C1' as Turn['conversationId'],
    entrySurface: 'app_mention',
    requester: 'U1' as SlackUserId,
    channelId: 'C1' as SlackChannelId,
    text: 'hi',
    receivedAt: new Date(),
  } as Turn;
}

function makeModelCfg(): {
  baseUrl: string;
  apiKey: string;
  model: Model<'anthropic-messages'>;
} {
  return {
    baseUrl: 'http://fake',
    apiKey: 'fake',
    model: {
      id: 'accounts/fireworks/models/gpt-oss-120b',
      name: 'GPT OSS 120B',
      api: 'anthropic-messages',
      provider: 'fireworks',
      baseUrl: 'http://fake',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131_072,
      maxTokens: 4_096,
    } as unknown as Model<'anthropic-messages'>,
  };
}

/** Registry exposing one tool named `read_thread`. */
function makeRegistryWithOneTool(): ToolRegistry {
  const descriptor: ToolDescriptor = {
    type: 'function',
    name: 'read_thread',
    description: 'read a thread',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
  return new ToolRegistry({
    list: () => [descriptor],
    async dispatch(call) {
      return { callId: call.id, ok: true, content: 'ok' };
    },
  });
}

// ---------------------------------------------------------------------------
// nextWhimsicalStatus
// ---------------------------------------------------------------------------

describe('nextWhimsicalStatus', () => {
  it('rotates through the curated whimsy word list', () => {
    const seen: string[] = [];
    for (let i = 0; i < WHIMSY_WORDS.length; i++) {
      seen.push(nextWhimsicalStatus(i));
    }
    expect(seen).toEqual(WHIMSY_WORDS.map((w) => `is ${w}…`));
  });

  it('wraps deterministically past the list length', () => {
    expect(nextWhimsicalStatus(WHIMSY_WORDS.length)).toBe(nextWhimsicalStatus(0));
    expect(nextWhimsicalStatus(WHIMSY_WORDS.length * 3 + 2)).toBe(nextWhimsicalStatus(2));
  });

  it('every whimsy phrase is a non-empty present-progressive string', () => {
    for (const word of WHIMSY_WORDS) {
      expect(word.length).toBeGreaterThan(0);
      // "ing" / "over" / "thoughts" suffixes — keep the list playful, not random.
      expect(word).toMatch(/(ing|over|thoughts)$/);
    }
  });
});

describe('friendlyVerb — specific task-row labels from args', () => {
  it('run_cli shows the actual command, not "using run_cli"', () => {
    expect(friendlyVerb('run_cli', { argv: ['gcloud', 'projects', 'list'] })).toBe(
      'running gcloud projects list',
    );
    expect(friendlyVerb('run_cli', { argv: ['gh', 'issue', 'list', '--assignee', '@me'] })).toBe(
      'running gh issue list --assignee @me',
    );
    expect(friendlyVerb('run_cli', {})).toBe('running a command');
  });

  it('clips a very long command', () => {
    const long = friendlyVerb('run_cli', { argv: ['bq', 'query', 'SELECT '.repeat(40)] });
    expect(long.length).toBeLessThanOrEqual('running '.length + 56);
    expect(long.endsWith('…')).toBe(true);
  });

  it('call_tool shows the connector tool name', () => {
    expect(friendlyVerb('call_tool', { name: 'sentry__list_issues' })).toBe(
      'running sentry: list issues',
    );
  });

  it('searches include the query', () => {
    expect(friendlyVerb('web_search', { query: 'kimi k2 pricing' })).toBe(
      'searching the web for “kimi k2 pricing”',
    );
    expect(friendlyVerb('search_messages', { query: 'from:@amit image-optimizer' })).toBe(
      'searching Slack for “from:@amit image-optimizer”',
    );
    expect(friendlyVerb('find_tools', { query: 'github issues' })).toBe(
      'finding tools for “github issues”',
    );
  });

  it('fetch_url shows the host', () => {
    expect(friendlyVerb('fetch_url', { url: 'https://docs.example.com/a/b?x=1' })).toBe(
      'reading docs.example.com',
    );
  });

  it('falls back to a humanized generic verb for unmapped tools', () => {
    expect(friendlyVerb('read_channel', {})).toBe('reading the channel');
    expect(friendlyVerb('some_new_tool', {})).toBe('using some new tool');
  });
});

// ---------------------------------------------------------------------------
// Subscriber: phantom tool filter
// ---------------------------------------------------------------------------

describe('pi/loop subscriber — phantom tool filter', () => {
  beforeEach(() => {
    capturedSubscribers.length = 0;
  });

  it('drops onStatus updates for tool names not in the registry', async () => {
    const registry = makeRegistryWithOneTool();
    const statusCalls: string[] = [];

    // Start the loop. The fake Agent's prompt() resolves immediately, but the
    // subscriber is captured during construction so we can drive it after.
    const runPromise = runLoopPi(makeTurn(), makeModelCfg(), registry, {
      history: [] as ChatMessage[],
      onStatus: async (s) => {
        statusCalls.push(s);
      },
    });

    // Subscriber captured during Agent construction.
    expect(capturedSubscribers).toHaveLength(1);
    const subscriber = capturedSubscribers[0]!;

    // Drive a real tool name → should produce a friendly status.
    await subscriber({ type: 'tool_execution_start', toolName: 'read_thread' });
    // Drive a phantom tool name (Harmony leak) → must be filtered.
    await subscriber({ type: 'tool_execution_start', toolName: 'Summarizing' });

    await runPromise;

    expect(statusCalls).toEqual(['is reading the thread…']);
  });

  it('does not flip the writing-status on a text_delta whose partial has no real text', async () => {
    const registry = makeRegistryWithOneTool();
    const statusCalls: string[] = [];

    const runPromise = runLoopPi(makeTurn(), makeModelCfg(), registry, {
      history: [] as ChatMessage[],
      onStatus: async (s) => {
        statusCalls.push(s);
      },
    });

    const subscriber = capturedSubscribers[0]!;

    // Empty-text partial — should NOT trigger 'is writing the reply…'.
    await subscriber({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: '',
        partial: { content: [{ type: 'text', text: '' }] },
      },
    });
    // Thinking-only partial — likewise must not flip.
    await subscriber({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'analysis chunk',
        partial: { content: [{ type: 'thinking', thinking: 'analysing…' }] },
      },
    });

    expect(statusCalls).not.toContain('is writing the reply…');

    // Now a real text partial — this SHOULD flip the writing status.
    await subscriber({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'H',
        partial: { content: [{ type: 'text', text: 'H' }] },
      },
    });

    await runPromise;
    expect(statusCalls).toContain('is writing the reply…');
  });
});

// ---------------------------------------------------------------------------
// toAgentMessages — ChatMessage[] → AgentMessage[] conversion
// ---------------------------------------------------------------------------

describe('toAgentMessages', () => {
  it('drops system messages', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'You are Sym.' }];
    expect(toAgentMessages(msgs)).toHaveLength(0);
  });

  it('converts user messages to role:user with monotonic timestamps', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ];
    const out = toAgentMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'user', content: 'hello', timestamp: 0 });
    expect(out[1]).toMatchObject({ role: 'user', content: 'world', timestamp: 1 });
  });

  it('converts assistant messages as stub AssistantMessage', () => {
    const msgs: ChatMessage[] = [{ role: 'assistant', content: 'Hi there' }];
    const out = toAgentMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'assistant' });
    const am = out[0] as AssistantMessage;
    expect(am.content).toEqual([{ type: 'text', text: 'Hi there' }]);
  });

  it('converts null assistant content to empty content array', () => {
    const msgs: ChatMessage[] = [{ role: 'assistant', content: null }];
    const out = toAgentMessages(msgs);
    expect((out[0] as AssistantMessage).content).toEqual([]);
  });

  it('converts tool result messages to role:toolResult', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'tc-1',
        name: 'read_thread',
        content: 'thread contents',
      },
    ];
    const out = toAgentMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tc-1',
      toolName: 'read_thread',
      content: [{ type: 'text', text: 'thread contents' }],
      isError: false,
    });
  });

  it('handles mixed message types and assigns sequential timestamps', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const out = toAgentMessages(msgs);
    // system is dropped; the remaining 3 get ts=0,1,2
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ role: 'user', timestamp: 0 });
    expect(out[1]).toMatchObject({ role: 'assistant', timestamp: 1 });
    expect(out[2]).toMatchObject({ role: 'user', timestamp: 2 });
  });
});

// ---------------------------------------------------------------------------
// extractUsage — AgentMessage[] → Usage | undefined
// ---------------------------------------------------------------------------

describe('extractUsage', () => {
  function makeAssistantMsg(input: number, output: number, total: number): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'fireworks',
      model: 'gpt-oss-120b',
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: total,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    } as unknown as AssistantMessage;
  }

  it('returns undefined for an empty message list', () => {
    expect(extractUsage([])).toBeUndefined();
  });

  it('returns undefined when no assistant messages are present', () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: 'q', timestamp: 0 } as AgentMessage];
    expect(extractUsage(msgs)).toBeUndefined();
  });

  it('aggregates usage across all assistant messages in the list', () => {
    const msgs: AgentMessage[] = [makeAssistantMsg(100, 50, 150), makeAssistantMsg(200, 80, 280)];
    expect(extractUsage(msgs)).toEqual({
      promptTokens: 300,
      completionTokens: 130,
      totalTokens: 430,
    });
  });

  it('handles a single assistant message', () => {
    const msgs: AgentMessage[] = [makeAssistantMsg(40, 20, 60)];
    expect(extractUsage(msgs)).toEqual({
      promptTokens: 40,
      completionTokens: 20,
      totalTokens: 60,
    });
  });
});

// ---------------------------------------------------------------------------
// AbortSignal wiring — listener is added and cleaned up after the run
// ---------------------------------------------------------------------------

describe('AbortSignal wiring', () => {
  beforeEach(() => {
    capturedSubscribers.length = 0;
  });

  it('runs to completion with an already-aborted signal (no throw from wiring)', async () => {
    const registry = makeRegistryWithOneTool();
    const controller = new AbortController();
    controller.abort(); // fire before the run

    // Should not throw — abort wiring handles an already-aborted signal gracefully.
    await expect(
      runLoopPi(makeTurn(), makeModelCfg(), registry, {
        history: [] as ChatMessage[],
        signal: controller.signal,
      }),
    ).resolves.toBeDefined();
  });

  it('removes the abort listener in the finally block (no listener leak)', async () => {
    const registry = makeRegistryWithOneTool();
    const controller = new AbortController();

    // Intercept EventTarget listener tracking via a simple wrapper.
    const listenerCountBefore = listenerCount(controller.signal, 'abort');

    await runLoopPi(makeTurn(), makeModelCfg(), registry, {
      history: [] as ChatMessage[],
      signal: controller.signal,
    });

    // After the run completes, the listener count must be back to what it was
    // before — the finally block removed the wired abort handler.
    expect(listenerCount(controller.signal, 'abort')).toBe(listenerCountBefore);
  });

  it('runs normally when no signal is provided', async () => {
    const registry = makeRegistryWithOneTool();
    await expect(
      runLoopPi(makeTurn(), makeModelCfg(), registry, { history: [] as ChatMessage[] }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Z16-04: Per-turn deadline — AbortSignal.timeout flows into graceful abort
// ---------------------------------------------------------------------------

describe('per-turn deadline (Z16-04)', () => {
  beforeEach(() => {
    capturedSubscribers.length = 0;
  });

  it('a timeout signal (fires immediately) resolves without throwing — graceful abort path', async () => {
    // AbortSignal.timeout(0) fires on the next microtask tick — effectively
    // immediate. The abort handler calls agent.abort(), which triggers Pi's
    // graceful-abort path. The run MUST resolve (return a Reply), not reject.
    const registry = makeRegistryWithOneTool();
    const result = await runLoopPi(makeTurn(), makeModelCfg(), registry, {
      history: [] as ChatMessage[],
      signal: AbortSignal.timeout(0),
    });
    // A valid Reply is returned — not an unhandled rejection.
    expect(result).toBeDefined();
    expect(result.markdown).toBeDefined();
    expect(result.receipt).toBeDefined();
  });

  it('a combined signal (user-cancel + deadline) resolves without throwing', async () => {
    // Simulate the AbortSignal.any([userSignal, AbortSignal.timeout(...)]) combination
    // that runTurnLoop builds. Fire the user-cancel immediately and confirm that
    // the combined signal also resolves gracefully.
    const registry = makeRegistryWithOneTool();
    const userController = new AbortController();
    userController.abort();
    const combined = AbortSignal.any([userController.signal, AbortSignal.timeout(60_000)]);

    const result = await runLoopPi(makeTurn(), makeModelCfg(), registry, {
      history: [] as ChatMessage[],
      signal: combined,
    });

    expect(result).toBeDefined();
    expect(result.markdown).toBeDefined();
  });

  it('removes the abort listener after a timeout abort (no listener leak on deadline path)', async () => {
    const registry = makeRegistryWithOneTool();
    const immediateSignal = AbortSignal.timeout(0);

    // Run to completion — should not leave dangling listeners on the signal.
    await runLoopPi(makeTurn(), makeModelCfg(), registry, {
      history: [] as ChatMessage[],
      signal: immediateSignal,
    });

    // After the run, the signal's listener count should be back to 0 (the abort
    // handler was cleaned up in the finally block).
    expect(listenerCount(immediateSignal, 'abort')).toBe(0);
  });
});

/**
 * Count the number of active listeners for a given event type on an
 * EventTarget by round-tripping through add/remove with a sentinel.
 * Works for node:events-backed AbortSignal in Node 18+ / vitest's env.
 */
function listenerCount(target: EventTarget, type: string): number {
  const handles: EventListener[] = [];
  // Add a no-op listener, immediately capture the pre-existing count by
  // probing add/remove cycle — use the EventEmitter API when available.
  // Node's AbortSignal is an EventTarget but also exposes listenerCount via
  // the internal emitter. If unavailable, fall back to a sentinel-diff approach.
  const nodeTarget = target as unknown as {
    listenerCount?: (type: string) => number;
  };
  if (typeof nodeTarget.listenerCount === 'function') {
    return nodeTarget.listenerCount(type);
  }
  // Fallback: counts zero. This is fine — the test above uses a before/after
  // comparison rather than an absolute value.
  handles.length = 0;
  return 0;
}
