import type { ToolCall } from './tools.js';

/** OpenAI-compatible chat roles. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A single message in the model conversation (OpenAI-chat shape). This is the
 * provider-facing message contract; the agent's runtime history is built from
 * Slack threads and converted into the model SDK's own message type at the seam.
 */
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

/** Token usage for one model turn, summed across the turn's assistant messages. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
