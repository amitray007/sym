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

import { nextWhimsicalStatus, runLoopPi, WHIMSY_WORDS } from '../src/pi/loop.js';

import type { Model } from '@earendil-works/pi-ai';
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
    name: 'read_thread',
    description: 'read a thread',
    inputSchema: { type: 'object' as const, properties: {} },
  };
  return new ToolRegistry({
    list: () => [descriptor],
    async dispatch() {
      return { content: 'ok' };
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
