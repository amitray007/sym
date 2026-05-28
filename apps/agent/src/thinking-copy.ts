/**
 * Rotated copy for the "Thinking" prelude row.
 *
 * The prelude is the first user-visible card row when a streamed reply opens.
 * Showing the same word ("Thinking") every turn gets stale; rotating across a
 * small curated set keeps the agent feeling alive without sliding into chatty
 * or twee territory.
 *
 * **Voice rules** (mirror Sym's system-prompt voice — see `packages/kernel/src/prompt.ts`):
 *  - Warm, concise, sharp colleague — never sycophantic or excited
 *  - No exclamation marks, no emoji, no "Sure!", no "I'd be happy to"
 *  - Present-progressive or short imperative; one to three words
 *  - Reads naturally as a card row label, NOT as a sentence the agent is
 *    saying to the owner
 *
 * **Selection is deterministic by turn id** so replays and log inspection
 * show the same word for the same turn — debugging stays easy. The runtime
 * doesn't allow `Math.random()` / `Date.now()` in workflow scripts; this
 * module avoids both for the same reproducibility reason.
 */
import type { TurnId } from '@sym/contracts';

/**
 * Curated rotation. Order is stable; keep entries roughly equal in tone so the
 * rotation feels coherent. Avoid duplicates with semantic overlap (e.g. don't
 * add both "On it" and "On the case"). 6–10 entries is the sweet spot — wide
 * enough that owners notice variety, narrow enough that each one stays meant.
 */
export const THINKING_COPY: readonly string[] = [
  // Original 8 — neutral / professional.
  'Thinking',
  'On it',
  'Got it',
  'Reading your message',
  'Looking into it',
  'Sizing this up',
  'Tracking that down',
  'One sec',

  // Expanded set — adds playful and investigative flavors. Same voice rules
  // (warm, sharp colleague — no exclamation, no emoji, no chatty filler).
  // Picked to feel coherent: "Cooking", "Brewing", "Crunching" are the
  // playful edge; the rest are conversational naturals. If any one ever
  // reads weird in a real reply context, trim it here — no other code
  // changes required.
  'Hmm',
  'Right',
  'Cooking',
  'Brewing',
  'Crunching',
  'Digging in',
  'Pulling threads',
  'Connecting dots',
  'On the case',
  'Pondering',
];

/**
 * Tiny deterministic string hash — sum of char codes mod length. Not
 * cryptographic; we just need a stable mapping from turn id → index. Avoids
 * pulling in a hash dep and keeps test expectations easy to write by hand.
 */
function indexFor(turnId: string, modulo: number): number {
  if (modulo <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < turnId.length; i++) {
    // `charCodeAt` always returns a number for valid indices.
    sum = (sum + turnId.charCodeAt(i)) % modulo;
  }
  return sum;
}

/**
 * Pick the prelude copy for a turn. Deterministic by `turnId` so the same
 * turn always shows the same word — replays and log slices look identical.
 *
 * Callers pass `turn.id` (the `TurnId` branded string). Empty/missing input
 * falls through to the first entry; we never throw from a UX-cosmetic path.
 */
export function pickThinkingCopy(turnId: TurnId | string | undefined): string {
  if (turnId === undefined || turnId.length === 0) {
    return THINKING_COPY[0]!;
  }
  const idx = indexFor(String(turnId), THINKING_COPY.length);
  return THINKING_COPY[idx]!;
}
