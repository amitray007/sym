import { assembleTurnMessages, buildSystemPrompt } from './prompt.js';
import { buildReceipt } from './receipt.js';

import type { ToolRegistry } from './tools.js';
import type {
  ChatMessage,
  CompletionChunk,
  FinishReason,
  JsonObject,
  ProviderInterface,
  Reply,
  ToolCall,
  ToolCallDelta,
  ToolResult,
  ToolRuntimeContext,
  Turn,
  Usage,
} from '@sym/contracts';

const MAX_TOOL_STEPS = 8;

/**
 * Options for a single kernel loop invocation.
 */
export interface LoopOptions {
  /** LLM model identifier (e.g. `accounts/fireworks/models/llama-v3p1-8b-instruct`). */
  model: string;
  /** Conversation history prior to this turn. */
  history?: ChatMessage[];
  /** AbortSignal to propagate cancellation to the provider. */
  signal?: AbortSignal;
  /**
   * Called with each text delta as it streams, for live output (e.g. Slack streaming).
   * The streamed draft equals the final `reply.markdown` — callers can concatenate
   * deltas to reconstruct it.
   */
  onDelta?: (delta: string) => void | Promise<void>;
}

/**
 * Internal: accumulate streaming `CompletionChunk`s into a finalized text +
 * usage summary.
 */
interface StreamAccumulator {
  textParts: string[];
  toolCallBuffers: Map<number, ToolCallBuffer>;
  finishReason?: FinishReason;
  usage?: Usage;
}

interface ToolCallBuffer {
  id?: string;
  name?: string;
  argumentsParts: string[];
}

function makeAccumulator(): StreamAccumulator {
  return {
    textParts: [],
    toolCallBuffers: new Map(),
  };
}

function applyChunk(acc: StreamAccumulator, chunk: CompletionChunk): void {
  if (chunk.delta.content) {
    acc.textParts.push(chunk.delta.content);
  }

  if (chunk.delta.toolCalls) {
    for (const delta of chunk.delta.toolCalls) {
      applyToolCallDelta(acc, delta);
    }
  }

  if (chunk.finishReason !== undefined) {
    acc.finishReason = chunk.finishReason;
  }
  if (chunk.usage !== undefined) {
    acc.usage = chunk.usage;
  }
}

function applyToolCallDelta(acc: StreamAccumulator, delta: ToolCallDelta): void {
  let buf = acc.toolCallBuffers.get(delta.index);
  if (!buf) {
    buf = { argumentsParts: [] };
    acc.toolCallBuffers.set(delta.index, buf);
  }
  const b = buf;
  if (delta.id !== undefined) b.id = delta.id;
  if (delta.name !== undefined) b.name = delta.name;
  if (delta.argumentsDelta !== undefined) b.argumentsParts.push(delta.argumentsDelta);
}

function parseArgs(s: string): JsonObject {
  try {
    const v: unknown = JSON.parse(s || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as JsonObject;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Finalize buffered tool call deltas into resolved ToolCall objects.
 * Entries with an empty name are skipped (incomplete/malformed deltas).
 */
function finalizeToolCalls(acc: StreamAccumulator): ToolCall[] {
  const calls: ToolCall[] = [];
  // Iterate in index order (Map preserves insertion order).
  for (const [, buf] of acc.toolCallBuffers) {
    if (!buf.name) continue;
    calls.push({
      id: buf.id ?? '',
      name: buf.name,
      arguments: parseArgs(buf.argumentsParts.join('')),
    });
  }
  return calls;
}

/**
 * Serialize a ToolResult to a string for the `tool` role message content.
 */
function toolResultContent(result: ToolResult): string {
  if (result.ok) {
    return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  }
  return `Error [${result.error.code}]: ${result.error.message}`;
}

function addUsage(totals: Usage, step: Usage): void {
  totals.promptTokens += step.promptTokens;
  totals.completionTokens += step.completionTokens;
  totals.totalTokens += step.totalTokens;
}

/**
 * `runLoop` — the thin agent loop.
 *
 * Ingest a `Turn`:
 *   1. Assemble `ChatMessage[]` (system + history + user turn with context prefix)
 *   2. Run the provider in a bounded multi-step loop (up to MAX_TOOL_STEPS)
 *   3. On each step: stream text deltas, detect tool calls, dispatch and feed results
 *   4. Build and return a `Reply` (with `Receipt`)
 *
 * Backward-compatible: when the registry is empty (`tools.length === 0`), the
 * provider receives no tool schemas so the model cannot emit tool calls. The
 * loop runs exactly one step and behaves identically to the prior single-pass
 * implementation.
 */
export async function runLoop(
  turn: Turn,
  provider: ProviderInterface,
  registry: ToolRegistry,
  opts: LoopOptions,
): Promise<Reply> {
  const startMs = Date.now();
  const history = opts.history ?? [];

  const systemContent = buildSystemPrompt();
  const messages: ChatMessage[] = assembleTurnMessages(systemContent, history, turn);

  const tools = registry.listTools();
  const dispatcher = registry.getDispatcher();

  const draftParts: string[] = [];
  const toolsInvoked: string[] = [];
  const usageTotals: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawUsage = false;

  let step = 0;
  while (true) {
    const acc = makeAccumulator();
    const req =
      tools.length > 0 ? { model: opts.model, messages, tools } : { model: opts.model, messages };

    for await (const chunk of provider.complete(req, opts.signal)) {
      applyChunk(acc, chunk);
      if (chunk.delta.content) {
        draftParts.push(chunk.delta.content);
        await opts.onDelta?.(chunk.delta.content);
      }
    }

    if (acc.usage !== undefined) {
      addUsage(usageTotals, acc.usage);
      sawUsage = true;
    }

    const stepText = acc.textParts.join('');
    const calls = finalizeToolCalls(acc);
    const wantsTools = acc.finishReason === 'tool_calls' || calls.length > 0;

    if (!wantsTools || !dispatcher || step >= MAX_TOOL_STEPS) break;

    // Append the assistant message that made the calls.
    messages.push({
      role: 'assistant',
      content: stepText.length > 0 ? stepText : null,
      toolCalls: calls,
    });

    const ctx: ToolRuntimeContext = {
      workspaceId: turn.workspaceId,
      conversationId: turn.conversationId,
      ...(turn.channelId !== undefined ? { channelId: turn.channelId } : {}),
      requester: turn.requester,
      turnId: turn.id,
    };

    for (const call of calls) {
      toolsInvoked.push(call.name);
      let result: ToolResult;
      try {
        result = await dispatcher.dispatch(call, ctx);
      } catch (err) {
        result = {
          callId: call.id,
          ok: false,
          error: { code: 'execution_failed', message: String(err) },
        };
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: toolResultContent(result),
      });
    }

    step++;
  }

  const finalMarkdown = draftParts.join('');
  const durationMs = Date.now() - startMs;

  const receiptParams = {
    turn,
    model: opts.model,
    durationMs,
    toolsInvoked,
    ...(sawUsage ? { usage: usageTotals } : {}),
  };
  const receipt = buildReceipt(receiptParams);

  return {
    turnId: turn.id,
    markdown: finalMarkdown,
    receipt,
  };
}
