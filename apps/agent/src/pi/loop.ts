/**
 * Pi-backed turn loop for Sym — the only turn path.
 *
 * Runs a single Slack turn through Pi's `Agent` class. The seam: a `Reply`
 * return type, an `onDelta` callback for streaming, and `history: ChatMessage[]`
 * input. The surrounding pipeline (ingress, owner-gate, context load, Slack
 * streaming) is unchanged.
 *
 * This module is the orchestrator and the public face of the pi-loop. Its
 * decomposed parts live alongside it and are re-exported below so existing
 * `from './pi/loop'` imports keep working:
 *  - `./agent-messages`  — ChatMessage ↔ AgentMessage conversion + usage
 *  - `./friendly-verb`   — tool name → status verb
 *  - `./agent-setup`     — per-turn tool list + system prompt assembly
 *  - `./loop-callbacks`  — the beforeToolCall gate + the event subscriber
 */

import { Agent } from '@earendil-works/pi-agent-core';

import { buildReceipt, buildUserTurnContent } from '@sym/kernel';

import { logCtx } from '../log.js';
import { resolveAllowlist, resolveCliCapabilities } from '../run-cli.js';
import { extractUsage, toAgentMessages } from './agent-messages.js';
import { buildAgentSystemPrompt, buildAgentTools, type TurnHelperCtx } from './agent-setup.js';
import { makeBeforeToolCall, makeSubscriber } from './loop-callbacks.js';
import { partitionDescriptors } from './meta-tools.js';

import type { ThinkingLevel } from './think-router.js';
import type { Model } from '@earendil-works/pi-ai';
import type { SlackClient } from '@sym/adapter-slack';
import type { ChatMessage, Reply, ToolRuntimeContext, Turn } from '@sym/contracts';
import type { OwnerIdentity, PersonaName, ToolRegistry } from '@sym/kernel';

// Re-export the decomposed helpers so `pi/loop` stays the module's public
// surface (tests + callers import toAgentMessages / extractUsage / friendlyVerb
// from here).
export { extractUsage, toAgentMessages } from './agent-messages.js';
export { friendlyVerb } from './friendly-verb.js';

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
  /**
   * The turn's active persona (resolved from a per-channel override or the
   * `SYM_PERSONA` home). Its full spec is injected as the active voice. Omitted →
   * default `'sym'`.
   */
  persona?: PersonaName;
  /** Called with each text delta for live streaming to Slack. */
  onDelta?: (delta: string) => void | Promise<void>;
  /**
   * Called with phase-aware status strings ("is searching Slack…", "is writing
   * the reply…") so callers can drive Slack's `assistant.threads.setStatus`
   * shimmer. Optional — loop runs fine when undefined.
   */
  onStatus?: (status: string) => void | Promise<void>;
  /**
   * Called with the Pi tool-call id and friendly verb for each tool that starts
   * executing (e.g. "reading the channel"). Used by the task card to track
   * steps live. `toolCallId` is Pi's per-call identifier — required so the
   * matching `onToolEnd` can settle the right task even when multiple tools
   * run in parallel (gpt-oss-120b commonly emits batched tool calls).
   */
  onToolStart?: (toolCallId: string, friendlyLabel: string) => void | Promise<void>;
  /**
   * Called when a tool finishes — `errored` is true if the tool threw. Pi
   * still feeds the error back to the model as a tool result, so the model
   * can recover and produce a "couldn't do X" reply. This callback surfaces
   * the failure to the task card so it renders red ✗ instead of a green
   * checkmark. `toolCallId` matches the value passed to onToolStart.
   */
  onToolEnd?: (toolCallId: string, errored: boolean) => void | Promise<void>;
  /**
   * Called when a destructive tool hits the confirm-before-running gate, and
   * again when the owner decides. Lets the task card show the gate INLINE on the
   * tool's own row — "<label> — awaiting approval" while blocked, then the row
   * flips to running on approve or "<label> — denied" on deny — instead of a
   * separate decision row. `toolCallId` matches the value onToolStart/onToolEnd
   * use for the same call, so the row is reused, never duplicated. Optional —
   * the plain (non-streamed) reply path has no task card and omits it.
   */
  onToolGate?: (
    toolCallId: string,
    phase: 'awaiting' | 'approved' | 'denied',
    friendlyLabel: string,
  ) => void | Promise<void>;
  /** Propagate cancellation into the Pi Agent. */
  signal?: AbortSignal;
  /**
   * Slack client for posting confirmation messages when a destructive tool is
   * about to run. Required for the confirm-before-destructive feature; when
   * absent, destructive tools are blocked (fail closed).
   */
  slackClient?: SlackClient;
  /**
   * Owner identity (name, tz, title) — passed through to
   * `buildUserTurnContent` so the per-turn metadata block carries enough info
   * for the model to address the owner naturally instead of by Slack id.
   */
  ownerProfile?: OwnerIdentity;
  /**
   * Reasoning effort for this turn, picked by the ingress router
   * (`think-router.ts`). Threaded through to Pi's `Agent.initialState.thinkingLevel`.
   * Omit to fall back to the safe default (`'low'`) — gpt-oss-120b on Fireworks
   * REQUIRES an explicit non-`off` value (see Agent construction below).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * When true, the agent asks the owner to confirm `run_cli` calls before
   * executing (except help/version introspection). Sourced from
   * `BehaviorConfig.cliConfirm` (env `SYM_CLI_CONFIRM`). Defaults to false.
   */
  cliConfirm?: boolean;
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

  // The user's message, with turn metadata framed as context-only so "summarize
  // it" refers to the conversation (in history), not the metadata. Same builder
  // as the kernel's assembleTurnMessages. When ownerProfile is supplied, an
  // `owner: Amit Ray (Asia/Kolkata, …) — id U…` line lands inside the
  // metadata block so the model knows who it's talking to.
  const userText = buildUserTurnContent(turn, opts.ownerProfile);

  // Partition the registry into built-ins (always bridged) and MCP tools
  // (deferred behind find_tools/call_tool to keep per-turn token cost low).
  const allDescriptors = registry.listTools();
  const { builtin: builtinDescriptors, mcp: mcpDescriptors } = partitionDescriptors(allDescriptors);

  // Resolve the CLI allowlist once per turn so both the tool list and the system
  // prompt catalog read from the same snapshot (no double config-file read).
  const cliAllowlist = resolveAllowlist();
  const cliCaps = resolveCliCapabilities();

  const hctx: TurnHelperCtx = { turn, modelCfg, opts, registry, ctx };

  const { agentTools, descriptorMap, knownToolNames, renders } = buildAgentTools(
    hctx,
    builtinDescriptors,
    mcpDescriptors,
    cliCaps,
  );

  const systemPrompt = buildAgentSystemPrompt(mcpDescriptors, cliAllowlist, cliCaps, opts.persona);

  // Accumulators shared between the subscriber and the post-run collection.
  const draftParts: string[] = [];
  const toolsInvoked: string[] = [];

  // Construct the Agent.
  //
  // thinkingLevel: routed per-turn by `think-router.ts` (default `'low'`).
  // gpt-oss-120b on Fireworks REQUIRES an explicit non-`off` effort: `'off'`
  // makes pi-ai send `thinking: { type: 'disabled' }`, which Fireworks
  // translates to `reasoning_effort: 'none'` and rejects with 400. The router
  // never emits `'off'` (its floor is `'low'`); fall back to `'low'` if no
  // value was supplied. We don't surface reasoning to users (thinking_delta
  // is filtered in the subscriber below), so the cost is purely model-side.
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: modelCfg.model,
      tools: agentTools,
      messages: historyMessages,
      thinkingLevel: opts.thinkingLevel ?? 'low',
    },
    getApiKey: (_provider: string) => modelCfg.apiKey,
    beforeToolCall: makeBeforeToolCall(hctx, descriptorMap),
  });

  agent.subscribe(makeSubscriber(opts, knownToolNames, draftParts, toolsInvoked));

  // Run the full multi-step loop (tools + follow-ups) via a single prompt call.
  //
  // Pi's Agent doesn't accept an AbortSignal on prompt(); abort via agent.abort().
  // Wire the signal so callers can cancel the run, and clean up the listener in a
  // finally block to avoid an event-listener leak when the signal outlives the run.
  // TODO: Pi may expose an AbortSignal on prompt() in a future SDK version.
  const abortHandler = (): void => {
    agent.abort();
  };
  opts.signal?.addEventListener('abort', abortHandler);
  try {
    await agent.prompt(userText);
  } finally {
    opts.signal?.removeEventListener('abort', abortHandler);
  }

  // Surface any error from Pi after the run settles.
  const errorMessage = agent.state.errorMessage;
  if (errorMessage) {
    console.warn(`${logCtx(turn.id)} [pi] agent completed with error:`, errorMessage);
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
    ...(renders.length > 0 ? { renders } : {}),
  };
}
