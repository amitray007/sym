/**
 * Run a turn through the Pi loop — shared by both delivery paths (streamed and
 * plain postMessage).
 *
 * Routes the reasoning effort per-turn from the user message + thread depth, and
 * applies a per-turn deadline via `AbortSignal.timeout` (combined with any
 * caller signal via `AbortSignal.any`, so either the user-cancel or the deadline
 * can abort). A timeout abort flows into Pi's graceful abort path (partial
 * reply), not an unhandled rejection.
 */

import { runLoopPi } from './pi/loop.js';
import { buildFireworksModel } from './pi/model.js';
import { pickThinkingLevel } from './pi/think-router.js';

import type { HandleTurnDeps } from './handle-turn.js';
import type { ChatMessage, Reply, Turn } from '@sym/contracts';
import type { ToolRegistry } from '@sym/kernel';

/**
 * Default per-turn deadline used when `SYM_TURN_DEADLINE_MS` is not set via
 * `BehaviorConfig`. Matches the default in `config.ts`.
 */
const DEFAULT_TURN_DEADLINE_MS = 60_000;

/**
 * Run the turn through the Pi loop.
 *
 * Single path — no fallback. `onDelta` and `history` are forwarded so the
 * streaming / postMessage pipeline is unchanged.
 *
 * A per-turn deadline is applied via `AbortSignal.timeout` (sourced from
 * `deps.behavior.turnDeadlineMs`; default 60 s). If a caller also supplies a
 * `signal`, the two are combined with `AbortSignal.any` so EITHER the user-cancel
 * OR the deadline can abort the run. A timeout abort flows into Pi's graceful
 * abort path (partial reply), not an unhandled rejection.
 */
export async function runTurnLoop(
  turn: Turn,
  deps: HandleTurnDeps,
  registry: ToolRegistry,
  history: ChatMessage[],
  onDelta?: (delta: string) => void | Promise<void>,
  onStatus?: (status: string) => void | Promise<void>,
  onToolStart?: (toolCallId: string, friendlyLabel: string) => void | Promise<void>,
  onToolEnd?: (toolCallId: string, errored: boolean) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<Reply> {
  const model = buildFireworksModel({
    baseUrl: deps.fireworks.baseUrl,
    modelId: deps.model,
  });
  // Route reasoning effort per-turn from the user message + thread depth. Pure
  // heuristic at ingress; the router never emits `'off'` (gpt-oss-120b on
  // Fireworks rejects it — see loop.ts Agent construction).
  const thinkingLevel = pickThinkingLevel({
    text: turn.text,
    threadDepth: history.length,
  });

  // Build the per-turn deadline signal. A deadline of 0 means "no cap".
  // Combine with any caller-supplied signal so both the user-cancel and the
  // deadline can abort the run — whichever fires first wins.
  const deadlineMs = deps.behavior.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
  const turnSignal =
    deadlineMs > 0
      ? signal !== undefined
        ? AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)])
        : AbortSignal.timeout(deadlineMs)
      : signal;

  return runLoopPi(
    turn,
    { baseUrl: deps.fireworks.baseUrl, apiKey: deps.fireworks.apiKey, model },
    registry,
    {
      history,
      slackClient: deps.slackClient,
      thinkingLevel,
      ...(deps.behavior.cliConfirm === true ? { cliConfirm: true } : {}),
      ...(onDelta !== undefined ? { onDelta } : {}),
      ...(onStatus !== undefined ? { onStatus } : {}),
      ...(onToolStart !== undefined ? { onToolStart } : {}),
      ...(onToolEnd !== undefined ? { onToolEnd } : {}),
      ...(deps.ownerProfile !== undefined ? { ownerProfile: deps.ownerProfile } : {}),
      ...(turnSignal !== undefined ? { signal: turnSignal } : {}),
    },
  );
}
