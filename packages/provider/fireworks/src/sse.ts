import { ProviderException, makeInvalidResponseError } from './errors.js';

import type { CompletionChunk, FinishReason, ToolCallDelta, Usage } from '@sym/contracts';

interface RawToolCall {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** OpenAI-compatible SSE delta shape (subset we parse). */
interface RawDelta {
  content?: string | null;
  tool_calls?: RawToolCall[];
}

interface RawChoice {
  delta: RawDelta;
  finish_reason?: string | null;
}

interface RawChunk {
  choices?: RawChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

function parseFinishReason(raw: string | null | undefined): FinishReason | undefined {
  if (!raw) return undefined;
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function parseUsage(raw: RawChunk['usage']): Usage | undefined {
  if (!raw) return undefined;
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? 0,
  };
}

/**
 * Parse one `data:` line from an OpenAI-compatible SSE stream into a
 * `CompletionChunk`. Returns `null` for `[DONE]`, throws `ProviderException`
 * for malformed JSON.
 */
export function parseSseLine(line: string): CompletionChunk | null {
  const trimmed = line.trim();
  if (trimmed === '[DONE]') return null;

  let raw: RawChunk;
  try {
    raw = JSON.parse(trimmed) as RawChunk;
  } catch (cause) {
    throw new ProviderException(
      makeInvalidResponseError(`SSE parse error: invalid JSON: ${trimmed.slice(0, 200)}`, cause),
    );
  }

  const choice = raw.choices?.[0];
  const delta: CompletionChunk['delta'] = {};

  if (choice?.delta.content) {
    delta.content = choice.delta.content;
  }

  if (choice?.delta.tool_calls && choice.delta.tool_calls.length > 0) {
    const toolCalls: ToolCallDelta[] = choice.delta.tool_calls.map((tc) => {
      const t: ToolCallDelta = { index: tc.index };
      if (tc.id !== undefined) t.id = tc.id;
      if (tc.function?.name !== undefined) t.name = tc.function.name;
      if (tc.function?.arguments !== undefined) t.argumentsDelta = tc.function.arguments;
      return t;
    });
    delta.toolCalls = toolCalls;
  }

  const chunk: CompletionChunk = { delta };

  const fr = parseFinishReason(choice?.finish_reason);
  if (fr !== undefined) {
    chunk.finishReason = fr;
  }

  const usage = parseUsage(raw.usage);
  if (usage) {
    chunk.usage = usage;
  }

  return chunk;
}

/**
 * Async generator that reads an SSE response body line-by-line and yields
 * `data:` content strings (stripping the `data:` prefix).
 */
export async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          yield trimmed.slice(5).trim();
        }
      }
    }

    // Flush remaining buffer.
    if (buffer.trim().startsWith('data:')) {
      yield buffer.trim().slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
