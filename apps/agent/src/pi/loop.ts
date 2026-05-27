/**
 * Pi-backed turn loop for Sym — the only turn path.
 *
 * Runs a single Slack turn through Pi's `Agent` class. The seam: a `Reply`
 * return type, an `onDelta` callback for streaming, and `history: ChatMessage[]`
 * input. The surrounding pipeline (ingress, owner-gate, context load, Slack
 * streaming) is unchanged.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { buildReceipt, buildSystemPrompt, buildUserTurnContent } from '@sym/kernel';

import { requestConfirmation } from '../confirmations.js';
import { bridgeTools } from './tools.js';

import type {
  BeforeToolCallContext,
  AgentEvent,
  AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, UserMessage, Model } from '@earendil-works/pi-ai';
import type { SlackClient } from '@sym/adapter-slack';
import type {
  ChatMessage,
  Reply,
  SlackChannelId,
  SlackThreadTs,
  ToolDescriptor,
  ToolRuntimeContext,
  Turn,
  Usage,
} from '@sym/contracts';
import type { ToolRegistry } from '@sym/kernel';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Fireworks credentials + model id extracted from workspace config. */
export interface PiModelCfg {
  baseUrl: string;
  apiKey: string;
  model: Model<'anthropic-messages'>;
}

/** Options accepted by `runLoopPi`. */
export interface PiLoopOptions {
  /** Conversation history prior to this turn (Sym's `ChatMessage[]` shape). */
  history: ChatMessage[];
  /** Called with each text delta for live streaming to Slack. */
  onDelta?: (delta: string) => void | Promise<void>;
  /**
   * Called with phase-aware status strings ("is searching Slack…", "is writing
   * the reply…") so callers can drive Slack's `assistant.threads.setStatus`
   * shimmer. Optional — loop runs fine when undefined.
   */
  onStatus?: (status: string) => void | Promise<void>;
  /** Propagate cancellation into the Pi Agent. */
  signal?: AbortSignal;
  /**
   * Slack client for posting confirmation messages when a destructive tool is
   * about to run. Required for the confirm-before-destructive feature; when
   * absent, destructive tools are blocked (fail closed).
   */
  slackClient?: SlackClient;
}

// ---------------------------------------------------------------------------
// ChatMessage → AgentMessage conversion
// ---------------------------------------------------------------------------

/**
 * Convert Sym's `ChatMessage[]` (OpenAI-chat shape) into Pi's `AgentMessage[]`.
 *
 * Pi requires a `timestamp` on every message; history messages get a synthetic
 * monotonic timestamp (0, 1, 2 …) so Pi treats them as ordered without
 * conflicting with real wall-clock values.
 *
 * Mapping:
 *  - `role:'system'`    → dropped (Pi receives the system prompt separately)
 *  - `role:'user'`      → `UserMessage { role:'user', content, timestamp }`
 *  - `role:'assistant'` → `AssistantMessage` (minimal stub; Pi re-uses history
 *                         for context, not for replay)
 *  - `role:'tool'`      → `ToolResultMessage { role:'toolResult', ... }`
 *
 * // TODO(pi): chunk 3 — for assistant messages that include tool calls, emit
 * the ToolCall content blocks so Pi's context window sees the full tool round-trip.
 * Currently we surface assistant text only; tool-call content is omitted.
 */
function toAgentMessages(history: ChatMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let ts = 0;

  for (const msg of history) {
    switch (msg.role) {
      case 'system':
        // Dropped — Pi gets the system prompt via AgentState.systemPrompt.
        break;

      case 'user': {
        const userMsg: UserMessage = {
          role: 'user',
          content: msg.content ?? '',
          timestamp: ts++,
        };
        out.push(userMsg);
        break;
      }

      case 'assistant': {
        // Stub an AssistantMessage with just the text content Pi needs for context.
        // A real stub needs the full AssistantMessage shape from pi-ai types.
        // TODO(pi): chunk 3 — include toolCall content blocks for full fidelity.
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: msg.content != null ? [{ type: 'text', text: msg.content }] : [],
          // History stub: align with the live model surface so Pi's re-serialization
          // for context doesn't see a mixed api union mid-conversation.
          api: 'anthropic-messages',
          provider: 'fireworks',
          model: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: ts++,
        };
        out.push(assistantMsg);
        break;
      }

      case 'tool': {
        // ToolResultMessage — Pi uses role 'toolResult' not 'tool'.
        out.push({
          role: 'toolResult' as const,
          toolCallId: msg.toolCallId ?? '',
          toolName: msg.name ?? '',
          content: [{ type: 'text', text: msg.content ?? '' }],
          isError: false,
          timestamp: ts++,
        });
        break;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Usage bridge
// ---------------------------------------------------------------------------

/**
 * Translate Pi's usage shape (from the final AssistantMessage) → Sym's `Usage`.
 * Returns `undefined` when no messages are present.
 */
function extractUsage(messages: AgentMessage[]): Usage | undefined {
  // Collect usage from all assistant messages produced during this turn.
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let found = false;

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const am = msg as AssistantMessage;
      promptTokens += am.usage.input;
      completionTokens += am.usage.output;
      totalTokens += am.usage.totalTokens;
      found = true;
    }
  }

  return found ? { promptTokens, completionTokens, totalTokens } : undefined;
}

// ---------------------------------------------------------------------------
// Status verbs
// ---------------------------------------------------------------------------

/**
 * Map a tool name → a friendly present-progressive verb phrase for Slack's
 * setStatus shimmer. Unmapped tools fall back to `using {toolName}`.
 */
const TOOL_VERBS: Record<string, string> = {
  read_thread: 'reading the thread',
  read_channel: 'reading the channel',
  get_current_time: 'checking the time',
};

function friendlyVerb(toolName: string): string {
  return TOOL_VERBS[toolName] ?? `using ${toolName}`;
}

// ---------------------------------------------------------------------------
// Whimsy — playful keepalive rotation
// ---------------------------------------------------------------------------

/**
 * Curated playful present-progressive words for long "still thinking" stretches.
 * Tool-specific verbs (TOOL_VERBS) stay concrete; this only kicks in on the
 * keepalive cycle when no real phase update has fired.
 */
export const WHIMSY_WORDS: readonly string[] = [
  'pondering',
  'cogitating',
  'ruminating',
  'musing',
  'marinating',
  'noodling',
  'wadoodling',
  'percolating',
  'mulling it over',
  'gathering thoughts',
];

/** Format a whimsical status string for the given keepalive tick. */
export function nextWhimsicalStatus(tick: number): string {
  const word =
    WHIMSY_WORDS[((tick % WHIMSY_WORDS.length) + WHIMSY_WORDS.length) % WHIMSY_WORDS.length]!;
  return `is ${word}…`;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Run a single Sym turn through Pi's `Agent`.
 *
 * Builds the Agent, subscribes for streaming text deltas, runs `prompt()`, then
 * collects the markdown reply and builds a `Receipt`.
 *
 * The `onDelta` callback is forwarded unchanged so `streamReply`'s buffer /
 * `chatAppendStream` pipeline works without modification.
 */
export async function runLoopPi(
  turn: Turn,
  modelCfg: PiModelCfg,
  registry: ToolRegistry,
  opts: PiLoopOptions,
): Promise<Reply> {
  const startMs = Date.now();

  // Build the ToolRuntimeContext passed to each tool dispatch.
  const ctx: ToolRuntimeContext = {
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    ...(turn.channelId !== undefined ? { channelId: turn.channelId } : {}),
    requester: turn.requester,
    turnId: turn.id,
  };

  // Convert Sym history → Pi AgentMessage[] (system messages are dropped;
  // Pi receives the system prompt via AgentState.systemPrompt).
  const historyMessages = toAgentMessages(opts.history);

  // The static base system prompt — byte-stable for provider prompt caching.
  const systemPrompt = buildSystemPrompt();

  // The user's message, with turn metadata framed as context-only so "summarize
  // it" refers to the conversation (in history), not the metadata. Same builder
  // as the kernel's assembleTurnMessages.
  const userText = buildUserTurnContent(turn);

  // Bridge the built-in tools as native Pi tools (full schemas visible up front).
  const descriptors = registry.listTools();
  const agentTools = bridgeTools(registry, ctx, descriptors);

  // Build a name → ToolDescriptor map so beforeToolCall can look up destructive hints.
  const descriptorMap = new Map<string, ToolDescriptor>(descriptors.map((d) => [d.name, d]));

  // Accumulate streaming text deltas.
  const draftParts: string[] = [];
  // Track tool invocations for the receipt.
  const toolsInvoked: string[] = [];

  // ---------------------------------------------------------------------------
  // Confirm-before-destructive hook
  //
  // For any tool whose descriptor carries `destructiveHint: true`, pause and ask
  // the owner to approve via Slack before executing. Fail CLOSED when the
  // confirmation channel is unavailable.
  // ---------------------------------------------------------------------------
  const beforeToolCall = async (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<{ block: true; reason?: string } | undefined> => {
    const toolName = context.toolCall.name;
    const descriptor = descriptorMap.get(toolName);

    if (descriptor?.destructiveHint !== true) {
      // Non-destructive or unknown — allow through immediately.
      return undefined;
    }

    // Honor abort — treat as deny.
    if (signal?.aborted) {
      return { block: true, reason: 'The run was cancelled before the tool could be approved.' };
    }

    const channelId = turn.channelId;
    if (!channelId || !opts.slackClient) {
      // Fail closed: no channel or no Slack client → cannot prompt → block.
      console.warn(`[pi] destructive tool '${toolName}' blocked: confirmation channel unavailable`);
      return { block: true, reason: 'Confirmation channel unavailable.' };
    }

    const argsPreview = JSON.stringify(context.args ?? {});

    const approved = await requestConfirmation({
      slackClient: opts.slackClient,
      channel: channelId as SlackChannelId,
      ...(turn.threadTs !== undefined ? { threadTs: turn.threadTs as SlackThreadTs } : {}),
      toolName,
      argsPreview,
    });

    if (!approved) {
      return { block: true, reason: 'The owner did not approve this action.' };
    }

    return undefined;
  };

  // Construct the Agent.
  //
  // thinkingLevel: 'low' — gpt-oss-120b on Fireworks REQUIRES an explicit
  // reasoning effort. Default 'off' makes pi-ai send `thinking: { type: 'disabled' }`,
  // which Fireworks translates to `reasoning_effort: 'none'` and rejects with 400.
  // We don't surface reasoning to users (thinking_delta is filtered in the
  // subscriber below), so 'low' keeps cost down while satisfying the API.
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: modelCfg.model,
      tools: agentTools,
      messages: historyMessages,
      thinkingLevel: 'low',
    },
    getApiKey: (_provider: string) => modelCfg.apiKey,
    beforeToolCall,
  });

  // The first text_delta (initial reply, or first delta after each tool round)
  // flips status to "is writing the reply…". Re-armed on every tool start.
  let emittedWritingStatus = false;

  // Subscribe to events for streaming + tool tracking.
  // The subscriber is synchronous where possible; async onDelta is awaited in-band.
  //
  // NOTE: `thinking_delta` events (Harmony analysis/commentary on the
  // anthropic-messages surface) are deliberately NOT routed anywhere — neither
  // onDelta nor onStatus. They're internal reasoning and must never appear in
  // the Slack message body or shimmer.
  agent.subscribe(async (event: AgentEvent) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta;
      // Only flip "writing" status when the partial actually carries a non-empty
      // text-type content block — guards against premature flips from edge-case
      // events where text_delta arrives before any real text is materialised.
      if (!emittedWritingStatus && opts.onStatus !== undefined) {
        const partial = event.assistantMessageEvent.partial;
        const hasRealText = partial.content.some((b) => b.type === 'text' && b.text.length > 0);
        if (hasRealText) {
          emittedWritingStatus = true;
          await opts.onStatus('is writing the reply…');
        }
      }
      draftParts.push(delta);
      await opts.onDelta?.(delta);
    }

    if (event.type === 'tool_execution_start') {
      const toolName = event.toolName;
      // Phantom tool guard: if some future model leaks a Harmony tool-call frame
      // that names a tool we never registered, drop the status update instead of
      // echoing garbage into the shimmer. Belt-and-braces for the demux fix.
      if (!descriptorMap.has(toolName)) {
        console.warn(`[pi] dropping status for unknown tool '${toolName}' (not in registry)`);
        return;
      }
      toolsInvoked.push(toolName);
      // Re-arm the "writing" status so the next text_delta after this tool flips it again.
      emittedWritingStatus = false;
      await opts.onStatus?.(`is ${friendlyVerb(toolName)}…`);
    }
  });

  // Run the full multi-step loop (tools + follow-ups) via a single prompt call.
  if (opts.signal) {
    // Pi's Agent doesn't accept an AbortSignal on prompt(); abort via agent.abort().
    // Wire the signal so callers can cancel the run.
    // TODO(pi): chunk 4 — Pi may expose signal on prompt() in a future version.
    opts.signal.addEventListener('abort', () => {
      agent.abort();
    });
  }

  await agent.prompt(userText);

  // Surface any error from Pi after the run settles.
  const errorMessage = agent.state.errorMessage;
  if (errorMessage) {
    console.warn('[pi] agent completed with error:', errorMessage);
  }

  // Never deliver a silent empty reply. If the run errored before producing any
  // text, surface the error to the owner — and push it through onDelta too, so it
  // appears in the live streaming path (not only the persisted/postMessage path).
  let finalMarkdown = draftParts.join('');
  if (finalMarkdown.length === 0 && errorMessage) {
    finalMarkdown = `⚠️ I ran into an error and couldn't finish that: ${errorMessage}`;
    await opts.onDelta?.(finalMarkdown);
  }

  const durationMs = Date.now() - startMs;

  // Extract usage from the messages Pi added during this run.
  const newMessages = agent.state.messages.slice(historyMessages.length);
  const usage = extractUsage(newMessages);

  const receipt = buildReceipt({
    turn,
    model: modelCfg.model.id,
    durationMs,
    toolsInvoked,
    ...(usage !== undefined ? { usage } : {}),
  });

  return {
    turnId: turn.id,
    markdown: finalMarkdown,
    receipt,
  };
}
