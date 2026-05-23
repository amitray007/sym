import { assembleTurnMessages, buildSystemPrompt } from './prompt.js';
import { buildReceipt } from './receipt.js';
import { applyToneRewrite } from './tone.js';

import type { ToolRegistry } from './tools.js';
import type {
  ChatMessage,
  CompletionChunk,
  FinishReason,
  ProviderInterface,
  Reply,
  SoulCascade,
  SoulLayerKind,
  ToolCallDelta,
  Turn,
  Usage,
} from '@sym/contracts';

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
}

/**
 * Internal: accumulate streaming `CompletionChunk`s into a finalized text +
 * usage summary. Follows the turn-loop: for now no tools, so we collect text
 * only. When tools are wired (S5) this expands into a multi-step loop.
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

/**
 * `runLoop` — the thin agent loop.
 *
 * Ingest a `Turn`:
 *   1. Assemble `ChatMessage[]` (system + history + user turn with context prefix)
 *   2. Call `provider.complete()` and consume the stream
 *   3. Apply the tone-rewrite stub
 *   4. Build and return a `Reply` (with `Receipt`)
 *
 * Tool calls in this version: with an empty registry, the provider receives
 * no tool schemas, so the model emits no tool calls. Any tool call deltas in
 * the stream are buffered but not dispatched (fail-closed per spec).
 *
 * Memory context: not yet wired (S7a stub — 0 memory hits).
 */
export async function runLoop(
  turn: Turn,
  provider: ProviderInterface,
  registry: ToolRegistry,
  cascade: SoulCascade,
  opts: LoopOptions,
): Promise<Reply> {
  const startMs = Date.now();
  const history = opts.history ?? [];

  const systemContent = buildSystemPrompt(cascade);
  const messages = assembleTurnMessages(systemContent, history, turn);

  const tools = registry.listTools();

  const acc = makeAccumulator();

  const completionReq =
    tools.length > 0 ? { model: opts.model, messages, tools } : { model: opts.model, messages };

  for await (const chunk of provider.complete(completionReq, opts.signal)) {
    applyChunk(acc, chunk);
  }

  const draftMarkdown = acc.textParts.join('');
  const durationMs = Date.now() - startMs;

  const toneResult = applyToneRewrite(cascade, draftMarkdown);
  const finalMarkdown = toneResult.accepted ? toneResult.rewrittenMarkdown : draftMarkdown;

  const soulLayersApplied: SoulLayerKind[] = cascade.layers.map((l) => l.kind);

  const receiptParams = {
    turn,
    model: opts.model,
    durationMs,
    toolsInvoked: [] as string[],
    soulLayersApplied,
    ...(acc.usage !== undefined ? { usage: acc.usage } : {}),
  };
  const receipt = buildReceipt(receiptParams);

  return {
    turnId: turn.id,
    markdown: finalMarkdown,
    receipt,
  };
}
