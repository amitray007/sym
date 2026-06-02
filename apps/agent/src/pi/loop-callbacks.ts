/**
 * The two per-turn Pi Agent callbacks: `beforeToolCall` (the confirm /
 * Slack-read-relevance gate) and the event subscriber (streaming deltas + tool
 * status). Both are factories closing over the per-turn context so the loop in
 * `./loop` stays a thin orchestrator.
 */

import { requestConfirmation } from '../confirmations.js';
import { logCtx } from '../log.js';
import { isIntrospectionOnly } from '../run-cli.js';
import { judgeSlackToolUse, SLACK_GUARD_TOOLS } from '../slack-guard.js';
import { friendlyVerb } from './friendly-verb.js';

import type { TurnHelperCtx } from './agent-setup.js';
import type { PiLoopOptions } from './loop.js';
import type { SlackGuardVerdict } from '../slack-guard.js';
import type { AgentEvent, BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { SlackChannelId, SlackThreadTs, ToolDescriptor } from '@sym/contracts';

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

/**
 * Factory for the `beforeToolCall` hook passed to Pi's Agent. Returns a closure
 * over the turn/model context and the per-turn `slackGuardVerdict` cache.
 *
 * Gates built-in tools only; MCP tools are confirmed inside `call_tool`.
 */
export function makeBeforeToolCall(
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
    // FAILS OPEN (allow) on any error — rationale: the guard is a best-effort
    // privacy/relevance layer, not a security boundary. Blocking a legitimate
    // Slack request is a worse outcome than occasionally allowing an ambiguous
    // one, and the model will self-correct on a useless Slack result. Blast
    // radius of fail-open: the model may run a Slack search that doesn't find
    // anything useful and will then try a different approach; it does NOT allow
    // destructive writes. Blast radius of fail-closed: a broken guard would
    // silently block all Slack reads, breaking the most common use case.
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
        } else {
          // No channel context available (e.g. response_url / slash-command turn
          // with no resolvable channelId, or slackClient absent). The guard
          // returned 'confirm' — meaning the read is privacy-sensitive — but we
          // have nowhere to ask the owner. We fail open here (allow) rather than
          // blocking a potentially legitimate read, but this IS a silent bypass:
          // the owner's private Slack content may be surfaced without explicit
          // approval. Z15-02: this is the privacy-sensitive code path on the
          // response_url flow where no channel is available for confirmation.
          console.warn(
            `${logCtx(turn.id)} [pi] guard verdict 'confirm' for '${toolName}' promoted to 'allow': no channel context for owner prompt`,
          );
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
      console.warn(
        `${logCtx(turn.id)} [pi] tool '${toolName}' blocked: confirmation channel unavailable`,
      );
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
export function makeSubscriber(
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
