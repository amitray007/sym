/**
 * Rotated shimmer copy for the per-turn status indicator.
 *
 * The shimmer is what Slack renders above the message via
 * `assistant.threads.setStatus` — the highlighted "is thinking…" text. It's
 * the agentic indicator the owner sees from t=0 until the first tool fires.
 * Hardcoding `'is thinking…'` every turn gets stale; rotating across a small
 * curated set keeps the agent feeling alive.
 *
 * **Voice rules** (mirror Sym's system-prompt voice):
 *  - Warm, sharp colleague — never sycophantic or excited
 *  - No exclamation marks, no emoji
 *  - Reads naturally after the literal prefix `is ` and before the ellipsis
 *    `…`. Almost always a present-progressive gerund.
 *  - 1–3 words after the prefix
 *
 * **Why not the prelude task row?** An earlier iteration emitted a
 * `task_update` card row with these phrases. Owner feedback (2026-05-29):
 * the rotation in the card was confusing — different words on each turn
 * for what was conceptually the same "I'm working" beat. The shimmer
 * (which is meant to feel ephemeral) is the right home for variety.
 *
 * **Why not customize Slack's empty-stream "Thinking..." text?**
 * `chat.startStream` doesn't expose a placeholder parameter — the
 * message-body "Thinking..." is Slack's own and we can't replace it.
 * We make peace with that flash; the shimmer is where we shape the agentic
 * indicator.
 *
 * **Selection is deterministic by turn id** so replays and log inspection
 * show the same phrase for the same turn — debugging stays easy. The
 * runtime doesn't allow `Math.random()` / `Date.now()` in workflow scripts;
 * this module avoids both for the same reproducibility reason.
 */
import type { TurnId } from '@sym/contracts';

/**
 * Bare phrases that fit the `is X…` shimmer template. Each entry should read
 * naturally when wrapped: `is ${entry}…`. Keep entries in voice — gerunds
 * preferred, no exclamation, no emoji.
 */
export const SHIMMER_PHRASES: readonly string[] = [
  'thinking',
  'pondering',
  'cooking',
  'brewing',
  'crunching',
  'mulling it over',
  'sizing this up',
  'tracking that down',
  'pulling on a thread',
  'connecting the dots',
  'digging in',
  'reading your message',
  'putting it together',
  'looking into it',
  'on the case',
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
    sum = (sum + turnId.charCodeAt(i)) % modulo;
  }
  return sum;
}

/**
 * Pick the BARE shimmer phrase for a turn (no `is `/`…` wrapping). Caller
 * is responsible for the template — typically `\`is ${phrase}…\``. Bare
 * form keeps callers flexible (one phrase reused for keepalive without
 * re-parsing).
 *
 * Deterministic by `turnId` so the same turn always shows the same phrase
 * — replays and log slices look identical. Empty/missing input falls
 * through to the first entry (`thinking`) — we never throw from a
 * cosmetic path.
 */
export function pickShimmerPhrase(turnId: TurnId | string | undefined): string {
  if (turnId === undefined || turnId.length === 0) {
    return SHIMMER_PHRASES[0]!;
  }
  const idx = indexFor(String(turnId), SHIMMER_PHRASES.length);
  return SHIMMER_PHRASES[idx]!;
}

/**
 * Convenience wrapper — return the full shimmer status string ready to pass
 * to `assistant.threads.setStatus`. Equivalent to `\`is ${pickShimmerPhrase(id)}…\``.
 */
export function pickShimmerStatus(turnId: TurnId | string | undefined): string {
  return `is ${pickShimmerPhrase(turnId)}…`;
}

// ---------------------------------------------------------------------------
// Whimsy — playful keepalive rotation
// ---------------------------------------------------------------------------

/**
 * Curated playful present-progressive words for long "still thinking" stretches.
 * Tool-specific verbs (TOOL_VERBS in pi/loop.ts) stay concrete; this only kicks
 * in on the keepalive cycle when no real phase update has fired.
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
