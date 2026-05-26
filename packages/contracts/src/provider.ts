import type { ToolCall, ToolDescriptor } from './tools.js';

/** OpenAI-compatible chat roles. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  /** `null` for an assistant message that only carries tool calls. */
  content: string | null;
  /** Present on assistant messages that invoke tools. */
  toolCalls?: ToolCall[];
  /** Present on `tool` messages: the call this responds to. */
  toolCallId?: string;
  /** Optional tool/function name on `tool` messages. */
  name?: string;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Streaming partial of a tool call — assembled across chunks by the kernel. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  /** Argument JSON arrives as a string delta and is concatenated, then parsed. */
  argumentsDelta?: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface CompletionChunk {
  delta: {
    content?: string;
    toolCalls?: ToolCallDelta[];
  };
  finishReason?: FinishReason;
  /** Some providers send usage only on the final chunk. */
  usage?: Usage;
}

/**
 * The provider completion contract. Fireworks is the current impl, via the
 * openai-completions API. Tools are passed per-request via `CompletionRequest.tools`.
 */
export interface ProviderInterface {
  /** Stable provider identifier, e.g. `fireworks`. */
  readonly id: string;
  complete(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<CompletionChunk>;
}
