/**
 * Adaptive thinking-level router for Pi turns.
 *
 * Pi's `Agent.initialState.thinkingLevel` controls per-turn reasoning effort.
 * Hardcoding `'low'` taxes complex asks; jumping to `'medium'` by default
 * taxes trivial asks. This router picks per turn from a small set of cheap
 * heuristics on the user message.
 *
 * **Floor is `'low'`, not `'off'`** — gpt-oss-120b on Fireworks rejects
 * `reasoning_effort: 'none'` with a 400. See [loop.ts](./loop.ts) constructor
 * comment. If the model surface ever supports `'off'`, widen the union here
 * and adjust the trivial branch.
 *
 * The router is intentionally a pure function: no I/O, no state. Wire it in
 * at ingress, pass the result through `PiLoopOptions.thinkingLevel`.
 */

/**
 * The subset of `ModelThinkingLevel` Sym actually emits. Narrower than
 * pi-ai's full union so callers can't accidentally pass `'off'` or `'xhigh'`
 * without a deliberate widening of this router.
 */
export type ThinkingLevel = 'low' | 'medium' | 'high';

/** Input to the routing heuristic — just what we can observe pre-turn. */
export interface RouterInput {
  /** Raw user message text (post bot-mention stripping is fine but not required). */
  text: string;
  /** Number of prior turns already in the thread (excludes the current message). */
  threadDepth: number;
}

// Heuristic constants — tuned by eye, not science. Adjust as we observe usage.
const TRIVIAL_MAX_LEN = 40;
const DEEP_THREAD_THRESHOLD = 10;
const MEDIUM_CLAUSE_THRESHOLD = 3;

const CLAUSE_PATTERN = /\b(and|then|also|after|before|once|while)\b/gi;
const DELIBERATIVE_PATTERN =
  /\b(think|analyze|investigate|figure out|decide|compare|reason|plan|design|debug|root cause)\b/i;

/**
 * Pick a thinking level for a single user turn.
 *
 * Rules, in order:
 *  1. **Trivial** (short, single-clause, ≤1 question) → `'low'` (the floor).
 *  2. **Deliberative or multi-clause** (explicit reasoning verb, ≥3 connectives,
 *     or deep thread) → `'medium'`.
 *  3. **Default** → `'low'`.
 *
 * `'high'` is reserved — not emitted today. The branch exists so callers can
 * widen the heuristic later (e.g. explicit `/think hard` opt-in) without a
 * type change.
 */
export function pickThinkingLevel(input: RouterInput): ThinkingLevel {
  const text = input.text.trim();
  const len = text.length;
  const clauseCount = (text.match(CLAUSE_PATTERN) ?? []).length;
  const questionCount = (text.match(/\?/g) ?? []).length;
  const isDeliberative = DELIBERATIVE_PATTERN.test(text);

  // Medium — explicit deliberation cue takes priority over the trivial-length
  // cutoff: "investigate X" is 14 chars but should still get reasoning budget.
  if (
    isDeliberative ||
    clauseCount >= MEDIUM_CLAUSE_THRESHOLD ||
    input.threadDepth > DEEP_THREAD_THRESHOLD
  ) {
    return 'medium';
  }

  // Trivial — short, simple, at most one question.
  if (len <= TRIVIAL_MAX_LEN && clauseCount === 0 && questionCount <= 1) {
    return 'low';
  }

  return 'low';
}
