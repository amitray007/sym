import { describe, expect, it } from 'vitest';

import { runLoop } from './loop.js';
import { buildDefaultSoulCascade } from './soul.js';
import { ToolRegistry } from './tools.js';

import type {
  CompletionChunk,
  CompletionRequest,
  ProviderInterface,
  Reply,
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
});
