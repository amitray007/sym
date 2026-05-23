import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderException } from './errors.js';
import { FireworksProvider } from './provider.js';

import type { CompletionRequest } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider() {
  return new FireworksProvider(
    { baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'test-key' },
    { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 },
  );
}

function makeSseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
}

/** Build a minimal SSE line for a content delta. */
function contentLine(content: string, finishReason?: string): string {
  const chunk = {
    choices: [
      {
        delta: { content },
        finish_reason: finishReason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}`;
}

/** Build a final SSE line with usage stats. */
function usageLine(): string {
  const chunk = {
    choices: [
      {
        delta: {},
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  return `data: ${JSON.stringify(chunk)}`;
}

/** Build a tool-call SSE line. */
function toolCallLine(index: number, id: string, name: string, args: string): string {
  const chunk = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              id,
              function: { name, arguments: args },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}`;
}

const baseRequest: CompletionRequest = {
  model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
  messages: [{ role: 'user', content: 'Hello' }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FireworksProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('id', () => {
    it('returns "fireworks"', () => {
      expect(makeProvider().id).toBe('fireworks');
    });
  });

  describe('streaming parse', () => {
    it('yields content chunks and final usage chunk', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([
          contentLine('Hello'),
          contentLine(', world!'),
          usageLine(),
          'data: [DONE]',
        ]),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', mockFetch);

      const provider = makeProvider();
      const chunks = [];
      for await (const chunk of provider.complete(baseRequest)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(3);
      expect(chunks[0]?.delta.content).toBe('Hello');
      expect(chunks[1]?.delta.content).toBe(', world!');
      // Third chunk has usage
      expect(chunks[2]?.usage).toEqual({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      });
    });

    it('yields tool call deltas', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([
          toolCallLine(0, 'call_abc', 'get_weather', '{"city":"NYC"}'),
          'data: [DONE]',
        ]),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', mockFetch);

      const provider = makeProvider();
      const chunks = [];
      for await (const chunk of provider.complete(baseRequest)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(1);
      const tc = chunks[0]?.delta.toolCalls?.[0];
      expect(tc).toBeDefined();
      expect(tc?.index).toBe(0);
      expect(tc?.id).toBe('call_abc');
      expect(tc?.name).toBe('get_weather');
      expect(tc?.argumentsDelta).toBe('{"city":"NYC"}');
    });

    it('stops at [DONE] without error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([contentLine('hi'), 'data: [DONE]']),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', mockFetch);

      const provider = makeProvider();
      const chunks = [];
      for await (const chunk of provider.complete(baseRequest)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(1);
    });

    it('ignores blank data lines', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody(['data: ', contentLine('hi'), 'data: [DONE]']),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', mockFetch);

      const provider = makeProvider();
      const chunks = [];
      for await (const chunk of provider.complete(baseRequest)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(1);
    });
  });

  describe('error mapping', () => {
    it('throws ProviderException with code "unauthorized" on 401', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          headers: new Headers(),
          text: async () => 'Unauthorized',
        }),
      );

      const provider = makeProvider();
      await expect(async () => {
        for await (const _chunk of provider.complete(baseRequest)) {
          // empty
        }
      }).rejects.toSatisfy(
        (e: unknown) => e instanceof ProviderException && e.providerError.code === 'unauthorized',
      );
    });

    it('throws ProviderException with code "upstream" on 500 after retries', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          headers: new Headers(),
          text: async () => 'Internal Server Error',
        }),
      );

      const provider = makeProvider();
      await expect(async () => {
        for await (const _chunk of provider.complete(baseRequest)) {
          // empty
        }
      }).rejects.toSatisfy(
        (e: unknown) => e instanceof ProviderException && e.providerError.code === 'upstream',
      );
    });

    it('throws ProviderException with code "invalid_response" on malformed JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: makeSseBody(['data: not-valid-json{']),
          headers: new Headers(),
        }),
      );

      const provider = makeProvider();
      await expect(async () => {
        for await (const _chunk of provider.complete(baseRequest)) {
          // empty
        }
      }).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ProviderException && e.providerError.code === 'invalid_response',
      );
    });
  });

  describe('429 retry with exponential backoff', () => {
    it('retries on 429 and succeeds on the next attempt', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers(),
          text: async () => 'rate limited',
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseBody([contentLine('retried ok'), 'data: [DONE]']),
          headers: new Headers(),
        });
      vi.stubGlobal('fetch', mockFetch);

      const provider = makeProvider();
      const chunks = [];
      for await (const chunk of provider.complete(baseRequest)) {
        chunks.push(chunk);
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(chunks[0]?.delta.content).toBe('retried ok');
    });

    it('throws "rate_limited" after exhausting retries', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: new Headers(),
          text: async () => 'rate limited',
        }),
      );

      const provider = makeProvider();
      await expect(async () => {
        for await (const _chunk of provider.complete(baseRequest)) {
          // empty
        }
      }).rejects.toSatisfy(
        (e: unknown) => e instanceof ProviderException && e.providerError.code === 'rate_limited',
      );
    });

    it('honours Retry-After header on 429', async () => {
      const retryHeaders = new Headers({ 'retry-after': '0' });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: retryHeaders,
          text: async () => 'rate limited',
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSseBody([contentLine('ok'), 'data: [DONE]']),
          headers: new Headers(),
        });
      vi.stubGlobal('fetch', mockFetch);

      const provider = makeProvider();
      const chunks = [];
      for await (const chunk of provider.complete(baseRequest)) {
        chunks.push(chunk);
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(chunks[0]?.delta.content).toBe('ok');
    });
  });

  describe('AbortSignal', () => {
    it('throws "timeout" when signal is already aborted', async () => {
      vi.stubGlobal('fetch', vi.fn()); // should not be called

      const controller = new AbortController();
      controller.abort();

      const provider = makeProvider();
      await expect(async () => {
        for await (const _chunk of provider.complete(baseRequest, controller.signal)) {
          // empty
        }
      }).rejects.toSatisfy(
        (e: unknown) => e instanceof ProviderException && e.providerError.code === 'timeout',
      );
    });
  });
});
