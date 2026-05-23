import { DEFAULT_RETRY_CONFIG } from './config.js';
import {
  ProviderException,
  makeInvalidResponseError,
  makeTimeoutError,
  mapHttpError,
} from './errors.js';
import { parseSseLine, readSseLines } from './sse.js';

import type { FireworksConfig, RetryConfig } from './config.js';
import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  ProviderInterface,
  ToolDescriptor,
} from '@sym/contracts';

/** Wire shape for a tool_call entry in an assistant message. */
interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Wire shape for a tool descriptor. */
interface WireTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** Wire shape for a chat message sent to the Fireworks API. */
interface FireworksMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Wire shape for the request body. */
interface FireworksRequestBody {
  model: string;
  messages: FireworksMessage[];
  stream: true;
  tools?: WireTool[];
  tool_choice?: 'auto' | 'none' | 'required';
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  stream_options?: { include_usage: true };
}

function toWireMessages(messages: ChatMessage[]): FireworksMessage[] {
  return messages.map((m) => {
    const wire: FireworksMessage = {
      role: m.role,
      content: m.content,
    };
    if (m.toolCalls && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
    if (m.toolCallId !== undefined) wire.tool_call_id = m.toolCallId;
    if (m.name !== undefined) wire.name = m.name;
    return wire;
  });
}

function toWireTools(tools: ToolDescriptor[]): WireTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function buildRequestBody(req: CompletionRequest): FireworksRequestBody {
  const body: FireworksRequestBody = {
    model: req.model,
    messages: toWireMessages(req.messages),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (req.tools && req.tools.length > 0) {
    body.tools = toWireTools(req.tools);
  }
  if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.stop && req.stop.length > 0) body.stop = req.stop;

  return body;
}

/**
 * `FireworksProvider` implements `ProviderInterface` against Fireworks' OpenAI-
 * compatible chat completions endpoint with SSE streaming.
 *
 * Configuration is injected at construction — no env reads, no live calls from
 * outside tests (tests mock `fetch`).
 */
export class FireworksProvider implements ProviderInterface {
  readonly id = 'fireworks';

  private readonly config: FireworksConfig;
  private readonly retry: RetryConfig;

  constructor(config: FireworksConfig, retry: RetryConfig = DEFAULT_RETRY_CONFIG) {
    this.config = config;
    this.retry = retry;
  }

  async *complete(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<CompletionChunk> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = buildRequestBody(req);

    let attempt = 0;

    while (true) {
      if (signal?.aborted) {
        throw new ProviderException(makeTimeoutError('Request aborted by caller'));
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: signal ?? null,
        });
      } catch (err) {
        // Network error or abort
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw new ProviderException(makeTimeoutError('Request aborted or timed out'));
        }
        throw new ProviderException(
          makeInvalidResponseError(
            `Fireworks fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
          ),
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const isRetryable = response.status === 429 || response.status >= 500;

        if (isRetryable && attempt < this.retry.maxRetries) {
          attempt++;
          const delay = Math.min(
            this.retry.baseDelayMs * Math.pow(2, attempt - 1),
            this.retry.maxDelayMs,
          );

          // Honour Retry-After header if present (for 429)
          const retryAfter = response.headers.get('retry-after');
          const waitMs = retryAfter
            ? Math.min(parseInt(retryAfter, 10) * 1000, this.retry.maxDelayMs)
            : delay;

          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, waitMs);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new ProviderException(makeTimeoutError('Aborted during retry backoff')));
            });
          });
          continue;
        }

        throw new ProviderException(mapHttpError(response.status, text));
      }

      if (!response.body) {
        throw new ProviderException(makeInvalidResponseError('Fireworks response has no body'));
      }

      // Stream SSE lines.
      for await (const dataLine of readSseLines(response.body)) {
        if (!dataLine) continue;

        const chunk = parseSseLine(dataLine);
        if (chunk === null) break; // [DONE]

        yield chunk;
      }

      return;
    }
  }
}
