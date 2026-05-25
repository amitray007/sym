import { describe, expect, it, vi } from 'vitest';

import { runLoop } from './loop.js';
import { buildDefaultSoulCascade } from './soul.js';
import { ToolRegistry } from './tools.js';

import type {
  CompletionChunk,
  CompletionRequest,
  ProviderInterface,
  Reply,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
  Turn,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Fake provider for hermetic tests
// ---------------------------------------------------------------------------

/** A fake provider that yields a fixed sequence of chunks. */
class FakeProvider implements ProviderInterface {
  readonly id = 'fake';
  private readonly chunks: CompletionChunk[];

  constructor(chunks: CompletionChunk[]) {
    this.chunks = chunks;
  }

  async *complete(_req: CompletionRequest, _signal?: AbortSignal): AsyncIterable<CompletionChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_01' as Turn['id'],
    workspaceId: 'ws_01' as Turn['workspaceId'],
    conversationId: 'conv_01' as Turn['conversationId'],
    entrySurface: 'app_mention',
    requester: 'U_alice' as Turn['requester'],
    channelId: 'C_general' as Turn['channelId'],
    text: 'Hello, Sym!',
    receivedAt: new Date('2026-05-24T00:00:00Z'),
    ...overrides,
  };
}

function makeContentChunk(content: string): CompletionChunk {
  return { delta: { content } };
}

function makeFinalChunk(content: string): CompletionChunk {
  return {
    delta: { content },
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLoop', () => {
  describe('basic turn → Reply', () => {
    it('produces a Reply from a Turn using a fake provider', async () => {
      const provider = new FakeProvider([
        makeContentChunk('Hello'),
        makeContentChunk(', '),
        makeFinalChunk('world!'),
      ]);

      const turn = makeTurn();
      const registry = new ToolRegistry();
      const cascade = buildDefaultSoulCascade();

      const reply: Reply = await runLoop(turn, provider, registry, cascade, {
        model: 'test-model',
      });

      expect(reply.turnId).toBe(turn.id);
      expect(reply.markdown).toBe('Hello, world!');
      expect(reply.receipt.turnId).toBe(turn.id);
      expect(reply.receipt.model).toBe('test-model');
    });

    it('includes usage in the receipt when provider sends it', async () => {
      const provider = new FakeProvider([
        {
          delta: { content: 'answer' },
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        },
      ]);

      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      expect(reply.receipt.usage).toEqual({
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      });
    });

    it('includes durationMs in the receipt', async () => {
      const provider = new FakeProvider([makeContentChunk('quick')]);

      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      expect(typeof reply.receipt.durationMs).toBe('number');
      expect(reply.receipt.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('populates soulLayersApplied from the cascade', async () => {
      const provider = new FakeProvider([makeContentChunk('ok')]);
      const cascade = buildDefaultSoulCascade();

      const reply = await runLoop(makeTurn(), provider, new ToolRegistry(), cascade, {
        model: 'test-model',
      });

      expect(reply.receipt.soulLayersApplied).toContain('l0_global');
    });

    it('records empty toolsInvoked when no tools registered', async () => {
      const provider = new FakeProvider([makeContentChunk('ok')]);

      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      expect(reply.receipt.toolsInvoked).toEqual([]);
    });

    it('records zero memoryHits (stub until S7a)', async () => {
      const provider = new FakeProvider([makeContentChunk('ok')]);

      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      expect(reply.receipt.memoryHits).toBe(0);
      expect(reply.receipt.memoryScopesUsed).toEqual([]);
    });
  });

  describe('empty stream', () => {
    it('returns empty markdown for a provider that yields nothing', async () => {
      const provider = new FakeProvider([]);

      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      expect(reply.markdown).toBe('');
    });
  });

  describe('tool call deltas (buffered, not dispatched — empty registry)', () => {
    it('does not dispatch tool calls when registry is empty', async () => {
      const provider = new FakeProvider([
        {
          delta: {
            toolCalls: [
              { index: 0, id: 'call_x', name: 'get_weather', argumentsDelta: '{"city":"NYC"}' },
            ],
          },
        },
        {
          delta: { content: 'I used a tool' },
          finishReason: 'stop',
        },
      ]);

      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      // No tool was dispatched, so toolsInvoked is empty.
      expect(reply.receipt.toolsInvoked).toEqual([]);
      // Text is still captured.
      expect(reply.markdown).toContain('I used a tool');
    });
  });

  describe('conversation history', () => {
    it('passes history to the provider', async () => {
      let capturedMessages: CompletionRequest['messages'] = [];

      const provider: ProviderInterface = {
        id: 'spy',
        async *complete(req) {
          capturedMessages = req.messages;
          yield makeContentChunk('replied');
        },
      };

      const history = [
        { role: 'user' as const, content: 'first message' },
        { role: 'assistant' as const, content: 'first reply' },
      ];

      await runLoop(makeTurn(), provider, new ToolRegistry(), buildDefaultSoulCascade(), {
        model: 'test-model',
        history,
      });

      // system + 2 history + 1 user turn
      expect(capturedMessages.length).toBe(4);
      expect(capturedMessages[0]?.role).toBe('system');
      expect(capturedMessages[1]?.content).toBe('first message');
      expect(capturedMessages[2]?.content).toBe('first reply');
      // Last message contains the turn text
      expect(capturedMessages[3]?.content).toContain('Hello, Sym!');
    });
  });

  describe('onDelta callback', () => {
    it('calls onDelta with each content delta in order, and reply.markdown equals concatenation', async () => {
      const provider = new FakeProvider([
        makeContentChunk('Hello'),
        makeContentChunk(', '),
        makeFinalChunk('world!'),
      ]);

      const deltas: string[] = [];
      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
          onDelta: (delta) => {
            deltas.push(delta);
          },
        },
      );

      expect(deltas).toEqual(['Hello', ', ', 'world!']);
      expect(reply.markdown).toBe(deltas.join(''));
    });

    it('does not call onDelta for chunks without content', async () => {
      const provider = new FakeProvider([
        makeContentChunk('text'),
        // chunk with no content (e.g. finish chunk)
        {
          delta: {},
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      ]);

      const deltas: string[] = [];
      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
          onDelta: (delta) => {
            deltas.push(delta);
          },
        },
      );

      expect(deltas).toEqual(['text']);
      expect(reply.markdown).toBe('text');
    });

    it('existing callers without onDelta are unaffected', async () => {
      const provider = new FakeProvider([makeContentChunk('Hello'), makeFinalChunk(' world')]);

      const reply = await runLoop(
        makeTurn(),
        provider,
        new ToolRegistry(),
        buildDefaultSoulCascade(),
        { model: 'test-model' },
      );

      expect(reply.markdown).toBe('Hello world');
    });
  });

  describe('AbortSignal propagation', () => {
    it('propagates the signal to the provider', async () => {
      let capturedSignal: AbortSignal | undefined;

      const provider: ProviderInterface = {
        id: 'spy',
        async *complete(_req, signal) {
          capturedSignal = signal;
          yield makeContentChunk('ok');
        },
      };

      const controller = new AbortController();
      await runLoop(makeTurn(), provider, new ToolRegistry(), buildDefaultSoulCascade(), {
        model: 'test-model',
        signal: controller.signal,
      });

      expect(capturedSignal).toBe(controller.signal);
    });
  });

  describe('system prompt', () => {
    it('first message is the system prompt', async () => {
      let firstMessage: { role: string; content: string | null } | undefined;

      const provider: ProviderInterface = {
        id: 'spy',
        async *complete(req) {
          firstMessage = req.messages[0];
          yield makeContentChunk('ok');
        },
      };

      await runLoop(makeTurn(), provider, new ToolRegistry(), buildDefaultSoulCascade(), {
        model: 'test-model',
      });

      expect(firstMessage?.role).toBe('system');
      expect(firstMessage?.content).toContain('Sym');
    });
  });

  describe('multi-step tool loop', () => {
    it('dispatches a tool call and feeds the result back, producing the final reply', async () => {
      // Call-counter provider: first call yields a tool_call, second yields text.
      let callCount = 0;
      const multiStepProvider: ProviderInterface = {
        id: 'multi-step-fake',
        async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
          callCount++;
          if (callCount === 1) {
            // Step 1: model wants to call get_current_time.
            yield {
              delta: {
                toolCalls: [
                  {
                    index: 0,
                    id: 'c1',
                    name: 'get_current_time',
                    argumentsDelta: '{}',
                  },
                ],
              },
            };
            yield {
              delta: {},
              finishReason: 'tool_calls',
              usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
            };
          } else {
            // Step 2: model produces the final answer.
            yield {
              delta: { content: 'It is 2026.' },
              finishReason: 'stop',
              usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
            };
          }
        },
      };

      const descriptor: ToolDescriptor = {
        type: 'function',
        name: 'get_current_time',
        description: 'Get the current UTC time.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        readOnlyHint: true,
      };

      const dispatchFn = vi.fn(
        async (call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> => {
          return { callId: call.id, ok: true, content: '2026-05-25T00:00:00Z' };
        },
      );

      const fakeDispatcher: ToolDispatcher = {
        list: () => [descriptor],
        dispatch: dispatchFn,
      };

      const registry = new ToolRegistry(fakeDispatcher);
      const turn = makeTurn();

      const reply: Reply = await runLoop(
        turn,
        multiStepProvider,
        registry,
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      // dispatch was called exactly once with the parsed call + correct ctx.
      expect(dispatchFn).toHaveBeenCalledOnce();
      const [dispatchedCall, dispatchedCtx] = dispatchFn.mock.calls[0]!;
      expect(dispatchedCall.name).toBe('get_current_time');
      expect(dispatchedCall.id).toBe('c1');
      expect(dispatchedCtx.workspaceId).toBe(turn.workspaceId);
      expect(dispatchedCtx.turnId).toBe(turn.id);

      // The second provider call received a role:'tool' message.
      // We verify this by checking that the provider was called twice.
      expect(callCount).toBe(2);

      // Final markdown is from step 2.
      expect(reply.markdown).toBe('It is 2026.');

      // toolsInvoked contains the tool name.
      expect(reply.receipt.toolsInvoked).toContain('get_current_time');
    });

    it('captures the tool message sent to the second provider call', async () => {
      let secondCallMessages: CompletionRequest['messages'] = [];
      let callCount = 0;

      const spyProvider: ProviderInterface = {
        id: 'spy',
        async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
          callCount++;
          if (callCount === 1) {
            yield {
              delta: {
                toolCalls: [{ index: 0, id: 'c2', name: 'get_current_time', argumentsDelta: '{}' }],
              },
              finishReason: 'tool_calls',
            };
          } else {
            secondCallMessages = req.messages;
            yield { delta: { content: 'Done.' }, finishReason: 'stop' };
          }
        },
      };

      const fakeDispatcher: ToolDispatcher = {
        list: () => [
          {
            type: 'function',
            name: 'get_current_time',
            description: 'time',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
        dispatch: async (call: ToolCall): Promise<ToolResult> => ({
          callId: call.id,
          ok: true,
          content: '2026-05-25T00:00:00Z',
        }),
      };

      await runLoop(
        makeTurn(),
        spyProvider,
        new ToolRegistry(fakeDispatcher),
        buildDefaultSoulCascade(),
        {
          model: 'test-model',
        },
      );

      // Second call messages should include a role:'tool' message.
      const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.content).toBe('2026-05-25T00:00:00Z');
      expect(toolMsg?.name).toBe('get_current_time');
    });
  });
});
