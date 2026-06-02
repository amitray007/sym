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
import {
  buildCliCatalog,
  isIntrospectionOnly,
  resolveAllowlist,
  resolveCliCapabilities,
} from '../run-cli.js';
import { judgeSlackToolUse, SLACK_GUARD_TOOLS } from '../slack-guard.js';
import {
  buildConnectorCatalog,
  makeCallTool,
  makeFindTools,
  parseMcpName,
  partitionDescriptors,
} from './meta-tools.js';
import { bridgeTools } from './tools.js';

import type { SlackGuardVerdict } from '../slack-guard.js';
import type { ThinkingLevel } from './think-router.js';
import type {
  BeforeToolCallContext,
  AgentEvent,
  AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, UserMessage, Model } from '@earendil-works/pi-ai';
import type { SlackClient } from '@sym/adapter-slack';
import type {
  ChatMessage,
  RenderIntent,
  Reply,
  SlackChannelId,
  SlackThreadTs,
  ToolDescriptor,
  ToolRuntimeContext,
  Turn,
  Usage,
} from '@sym/contracts';
import type { OwnerIdentity, ToolRegistry } from '@sym/kernel';

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
export function toAgentMessages(history: ChatMessage[]): AgentMessage[] {
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
export function extractUsage(messages: AgentMessage[]): Usage | undefined {
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
  read_user_profile: 'looking up the user',
  fetch_url: 'reading the page',
  list_channels: 'listing channels',
  post_as_owner: 'sending a message as you',
  react_as_owner: 'reacting as you',
  set_status: 'updating your status',
  add_reminder: 'setting a reminder',
  delete_message: 'deleting its message',
  // find_tools / call_tool are specialized from args in friendlyVerb (below).
  // NOTE: no entry for set_plan / present_* — they're in SILENT_TOOLS, so a
  // verb here would be dead (their start never reaches the shimmer/card).
};

/**
 * Tools whose execution is metadata-only — no shimmer, no task-card row, no
 * receipt entry. The model uses them to mutate plan state; surfacing them in
 * the UI would create noise on every checkmark.
 *
 * `set_plan` lives here because the tool's start fires BEFORE plan-mode
 * latches (the latch happens during the tool's dispatch, in
 * `PlanController.setPlan`). A "Planning the work" tool row would slip
 * onto the card before the actual plan items render, then never settle
 * cleanly — the screenshot from 2026-05-29 showed it sitting at error.
 * The PlanController's own `set_plan` event drives the visible rows; the
 * tool execution itself is invisible.
 */
const SILENT_TOOLS: ReadonlySet<string> = new Set([
  'update_task',
  'set_plan',
  // present_* render the answer itself — they aren't "work". A "using
  // present_card" shimmer / card row is noise, so keep them invisible.
  'present_card',
  'present_table',
]);

/** "sentry__search_issues" → "sentry: search issues" for readable status. */
function humanizeMcpName(name: string): string {
  const { connector, local } = parseMcpName(name);
  if (connector === local) return name.replace(/_/g, ' ');
  return `${connector}: ${local.replace(/_/g, ' ')}`;
}

/** Clip a value for a task-row title — short, single-line, scannable. */
function clip(s: string, max = 56): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A trimmed, non-empty string argument, or undefined. */
function strArg(args: unknown, key: string): string | undefined {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * A SPECIFIC, present-progressive status verb for a tool call. Where a tool's
 * arguments carry meaning, we surface them — the actual command (`run_cli`), the
 * search query, the connector tool, the URL host — so the owner sees what's
 * really happening ("Running gcloud projects list") instead of the bare tool
 * name ("Using run_cli"). Generic tools fall back to TOOL_VERBS; anything
 * unmapped reads as "using <tool name>". Exported for tests.
 */
export function friendlyVerb(toolName: string, args?: unknown): string {
  switch (toolName) {
    case 'run_cli': {
      const argv = (args as { argv?: unknown } | undefined)?.argv;
      if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) {
        return `running ${clip((argv as string[]).join(' '))}`;
      }
      return 'running a command';
    }
    case 'call_tool': {
      const name = (args as { name?: unknown } | undefined)?.name;
      return typeof name === 'string' && name.length > 0
        ? `running ${humanizeMcpName(name)}`
        : 'running a connector tool';
    }
    case 'find_tools': {
      const q = strArg(args, 'query');
      return q !== undefined ? `finding tools for “${clip(q, 40)}”` : 'finding the right tool';
    }
    case 'web_search': {
      const q = strArg(args, 'query');
      return q !== undefined ? `searching the web for “${clip(q, 40)}”` : 'searching the web';
    }
    case 'search_messages': {
      const q = strArg(args, 'query');
      return q !== undefined ? `searching Slack for “${clip(q, 40)}”` : 'searching Slack';
    }
    case 'fetch_url': {
      const url = strArg(args, 'url');
      if (url !== undefined) {
        try {
          return `reading ${new URL(url).hostname}`;
        } catch {
          return `reading ${clip(url, 40)}`;
        }
      }
      return 'reading the page';
    }
    default:
      return TOOL_VERBS[toolName] ?? `using ${toolName.replace(/_/g, ' ')}`;
  }
}

// ---------------------------------------------------------------------------
// Per-turn helper builders
// ---------------------------------------------------------------------------

/** Context objects threaded into the per-turn helper builders. */
interface TurnHelperCtx {
  turn: Turn;
  modelCfg: PiModelCfg;
  opts: PiLoopOptions;
  registry: ToolRegistry;
  ctx: ToolRuntimeContext;
}

/**
 * Assemble the Pi `AgentTool[]` for one turn: bridged built-ins + the two
 * on-demand meta-tools (`find_tools` / `call_tool`) when MCP or CLI caps exist.
 * Returns the tool list, a parallel `knownToolNames` guard set (for the
 * phantom-tool filter), and the mutable `renders` sink for render intents.
 */
function buildAgentTools(
  hctx: TurnHelperCtx,
  builtinDescriptors: ToolDescriptor[],
  mcpDescriptors: ToolDescriptor[],
  cliCaps: ReturnType<typeof resolveCliCapabilities>,
): {
  agentTools: ReturnType<typeof bridgeTools>;
  descriptorMap: Map<string, ToolDescriptor>;
  knownToolNames: Set<string>;
  renders: RenderIntent[];
} {
  const { registry, ctx, turn, opts } = hctx;
  const renders: RenderIntent[] = [];
  const onRender = (r: RenderIntent): void => {
    renders.push(r);
  };

  // MCP confirm — call_tool self-gates because the model invokes `call_tool`,
  // not the underlying MCP tool name. Fails CLOSED when channel is unavailable.
  const confirmMcp = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    const channelId = turn.channelId;
    if (!channelId || !opts.slackClient) {
      console.warn(`[pi] mcp tool '${toolName}' blocked: confirmation channel unavailable`);
      return false;
    }
    return requestConfirmation({
      slackClient: opts.slackClient,
      channel: channelId as SlackChannelId,
      ...(turn.threadTs !== undefined ? { threadTs: turn.threadTs as SlackThreadTs } : {}),
      toolName,
      args,
    });
  };

  const agentTools = [
    ...bridgeTools(registry, ctx, builtinDescriptors, onRender),
    // find_tools searches BOTH MCP tools and CLIs, so it's worth offering whenever
    // either exists. call_tool is MCP-only.
    ...(mcpDescriptors.length > 0 || cliCaps.length > 0
      ? [makeFindTools({ mcp: mcpDescriptors, cli: cliCaps })]
      : []),
    ...(mcpDescriptors.length > 0
      ? [makeCallTool({ mcp: mcpDescriptors, registry, ctx, confirm: confirmMcp, onRender })]
      : []),
  ];

  // beforeToolCall gates only natively-bridged built-ins; MCP confirm lives in call_tool.
  const descriptorMap = new Map<string, ToolDescriptor>(builtinDescriptors.map((d) => [d.name, d]));

  // Tool names the UI status/task-card layer recognises: built-ins + the
  // on-demand meta-tools. find_tools/call_tool are real tool calls but aren't
  // registered descriptors, so they must be listed here or their status gets
  // dropped by the phantom-tool guard.
  const knownToolNames = new Set<string>([
    ...descriptorMap.keys(),
    ...(mcpDescriptors.length > 0 ? ['find_tools', 'call_tool'] : []),
  ]);

  return { agentTools, descriptorMap, knownToolNames, renders };
}

/**
 * Compose the full system prompt for one turn: static base + connector catalog
 * + CLI catalog. Static sections are cache-stable across turns when the
 * connector set and allowlist don't change.
 */
function buildAgentSystemPrompt(
  mcpDescriptors: ToolDescriptor[],
  cliAllowlist: ReturnType<typeof resolveAllowlist>,
  cliCaps: ReturnType<typeof resolveCliCapabilities>,
): string {
  const baseSystemPrompt = buildSystemPrompt();
  // Append live capability catalogs so the model knows what's reachable THIS turn:
  // MCP connectors (via find_tools/call_tool) + CLIs (via run_cli, with what each
  // is for). Both are per-turn snapshots; the static prompt tells the model to
  // introspect (`sym status`/`sym tools`/`find_tools`) rather than trust a cached list.
  const catalog = buildConnectorCatalog(mcpDescriptors);
  const cliCatalog = buildCliCatalog(cliAllowlist, cliCaps);
  return [baseSystemPrompt, catalog, cliCatalog].filter((s) => s.length > 0).join('\n\n');
}

/**
 * Factory for the `beforeToolCall` hook passed to Pi's Agent. Returns a closure
 * over the turn/model context and the per-turn `slackGuardVerdict` cache.
 *
 * Gates built-in tools only; MCP tools are confirmed inside `call_tool`.
 */
function makeBeforeToolCall(
  hctx: TurnHelperCtx,
  descriptorMap: Map<string, ToolDescriptor>,
): (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<{ block: true; reason?: string } | undefined> {
  const { turn, modelCfg, opts } = hctx;

  // Per-turn cache for the Slack-read relevance guard. Computed at most once
  // (the first time a broad Slack read is attempted) and reused for the rest of
  // the turn so the guard costs one fast LLM call regardless of how many Slack
  // reads the model makes. A `confirm` that the owner approves is upgraded to
  // `allow` so we don't re-prompt for every subsequent Slack read.
  let slackGuardVerdict: SlackGuardVerdict | undefined;

  return async (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<{ block: true; reason?: string } | undefined> => {
    const toolName = context.toolCall.name;

    // -------------------------------------------------------------------------
    // Slack-read relevance guard
    //
    // Before a broad Slack read runs, make sure the request is actually about
    // Slack conversations — not an external-system task the model is trying to
    // answer with a Slack search, and not something that would leak the owner's
    // private content into a shared channel. One fast LLM call, cached per turn,
    // fails OPEN (allow) on any error.
    // -------------------------------------------------------------------------
    if (SLACK_GUARD_TOOLS.has(toolName)) {
      if (slackGuardVerdict === undefined) {
        slackGuardVerdict = await judgeSlackToolUse(turn.text ?? '', {
          fireworks: { baseUrl: modelCfg.baseUrl, apiKey: modelCfg.apiKey },
          model: modelCfg.model.id,
          visibility: turn.entrySurface === 'dm' ? 'private' : 'shared',
        });
      }

      if (slackGuardVerdict === 'redirect') {
        return {
          block: true,
          reason: `${toolName} only searches Slack conversations — it can't reach external systems. This request looks like a task in another system (a repo, cloud, issue tracker, etc.). Use find_tools to discover the right connector or CLI instead of a Slack search.`,
        };
      }

      if (slackGuardVerdict === 'confirm') {
        const channelId = turn.channelId;
        if (channelId && opts.slackClient) {
          const approved = await requestConfirmation({
            slackClient: opts.slackClient,
            channel: channelId as SlackChannelId,
            ...(turn.threadTs !== undefined ? { threadTs: turn.threadTs as SlackThreadTs } : {}),
            toolName,
            args: (context.args ?? {}) as Record<string, unknown>,
          });
          if (!approved) {
            return { block: true, reason: 'The owner did not approve this Slack operation.' };
          }
        }
        // Approved (or no channel to prompt on → fail open). Don't re-ask for
        // the rest of the turn.
        slackGuardVerdict = 'allow';
      }
    }

    // Decide whether this call needs owner confirmation.
    let needsConfirm: boolean;
    if (toolName === 'run_cli') {
      // run_cli is unconfirmed by default (full freedom within SYM_CLI_ALLOWLIST).
      // cliConfirm (sourced from BehaviorConfig / SYM_CLI_CONFIRM) gates real
      // commands; help/version introspection stays free so the agent can learn a
      // CLI without prompting.
      const argvRaw = (context.args as { argv?: unknown } | undefined)?.argv;
      const argv = Array.isArray(argvRaw)
        ? argvRaw.filter((a): a is string => typeof a === 'string')
        : [];
      needsConfirm = opts.cliConfirm === true && !isIntrospectionOnly(argv);
    } else {
      needsConfirm = descriptorMap.get(toolName)?.destructiveHint === true;
    }

    if (!needsConfirm) {
      // Non-destructive / unconfirmed — allow through immediately.
      return undefined;
    }

    // Honor abort — treat as deny.
    if (signal?.aborted) {
      return { block: true, reason: 'The run was cancelled before the tool could be approved.' };
    }

    const channelId = turn.channelId;
    if (!channelId || !opts.slackClient) {
      // Fail closed: no channel or no Slack client → cannot prompt → block.
      console.warn(`[pi] tool '${toolName}' blocked: confirmation channel unavailable`);
      return { block: true, reason: 'Confirmation channel unavailable.' };
    }

    const approved = await requestConfirmation({
      slackClient: opts.slackClient,
      channel: channelId as SlackChannelId,
      ...(turn.threadTs !== undefined ? { threadTs: turn.threadTs as SlackThreadTs } : {}),
      toolName,
      args: (context.args ?? {}) as Record<string, unknown>,
    });

    if (!approved) {
      return { block: true, reason: 'The owner did not approve this action.' };
    }

    return undefined;
  };
}

/**
 * Factory for the Pi Agent event subscriber. Returns a closure over the shared
 * `draftParts` / `toolsInvoked` accumulators and the mutable `emittedWritingStatus`
 * flag so consecutive tool–reply cycles re-arm the "writing" shimmer correctly.
 *
 * NOTE: `thinking_delta` events (Harmony reasoning on the anthropic-messages
 * surface) are deliberately NOT routed anywhere — neither onDelta nor onStatus.
 * They're internal reasoning and must never appear in the Slack message body or
 * shimmer.
 */
function makeSubscriber(
  opts: PiLoopOptions,
  knownToolNames: Set<string>,
  draftParts: string[],
  toolsInvoked: string[],
): (event: AgentEvent) => Promise<void> {
  // The first text_delta (initial reply, or first delta after each tool round)
  // flips status to "is writing the reply…". Re-armed on every tool start.
  let emittedWritingStatus = false;

  return async (event: AgentEvent): Promise<void> => {
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
      if (!knownToolNames.has(toolName)) {
        console.warn(`[pi] dropping status for unknown tool '${toolName}' (not in registry)`);
        return;
      }
      // Silent tools (e.g. `update_task`) mutate plan state only — no shimmer,
      // no card row, no receipt entry. The PlanController already drove the
      // matching UI update via its own event.
      if (SILENT_TOOLS.has(toolName)) return;
      toolsInvoked.push(toolName);
      // Re-arm the "writing" status so the next text_delta after this tool flips it again.
      emittedWritingStatus = false;
      const verb = friendlyVerb(toolName, event.args);
      await opts.onStatus?.(`is ${verb}…`);
      await opts.onToolStart?.(event.toolCallId, verb);
    }

    if (event.type === 'tool_execution_end') {
      const toolName = event.toolName;
      // Same phantom-tool guard as start — we only surface end events for tools
      // we actually started. Pi feeds the error/result back to the model
      // internally; this is purely UI-facing.
      if (!knownToolNames.has(toolName)) return;
      // Silent tools never fired onToolStart, so onToolEnd would be unbalanced.
      if (SILENT_TOOLS.has(toolName)) return;
      await opts.onToolEnd?.(event.toolCallId, event.isError);
    }
  };
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

  const systemPrompt = buildAgentSystemPrompt(mcpDescriptors, cliAllowlist, cliCaps);

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
  // TODO(pi): chunk 4 — Pi may expose signal on prompt() in a future version.
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
    ...(renders.length > 0 ? { renders } : {}),
  };
}
