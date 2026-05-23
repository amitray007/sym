/**
 * Change-policy classifier.
 *
 * `classify(turn, candidate, existing, provider)` → `ChangePolicyDecision`
 *
 * Four-state output:
 *   add       — new, independent fact; insert a new row
 *   update    — refines/sharpens existing memory without contradicting
 *   supersede — contradicts an existing memory; old → superseded, new inserted
 *   ignore    — chitchat, single passing mention, Sym's own output, failed
 *               tool calls; nothing written
 *
 * Substantive signals that lift a candidate above `ignore`:
 *   1. Explicit "remember this" / "from now on" / "always" / "never"
 *   2. Repeated mention (≥2× across turns, tunable; default checked here)
 *   3. Preference statements: "I prefer X / always X / never X"
 *   4. (Tool-call habit is tracked externally by the kernel; not here)
 *
 * Provider is INJECTED. This module makes no env reads and no live calls.
 * Tests supply a fake ProviderInterface that returns controlled JSON.
 */

import type { ChangePolicyDecision, MemoryEntry, ProviderInterface, Turn } from '@sym/contracts';

/** The text the classifier sends to the provider model. */
const CLASSIFY_SYSTEM_PROMPT = `You are the memory change-policy classifier for Sym, an AI teammate.

Your job: given a conversation turn and a candidate memory fact, decide what should happen to Sym's memory.

Return ONLY a JSON object in this exact shape (no markdown, no commentary):
{"decision": "<add|update|supersede|ignore>", "reason": "<one sentence>", "existing_id": "<id or null>"}

Rules:
- "add": the candidate is a new, independent fact not covered by any existing memory.
- "update": the candidate refines, sharpens, or adds detail to an existing memory without contradicting it. Set existing_id to the id of the memory being refined.
- "supersede": the candidate directly contradicts an existing memory. Set existing_id to the id of the memory being superseded.
- "ignore": the candidate is chitchat, a single passing mention with no intent to remember, Sym's own output quoted back, or failed/hypothetical tool calls.

Substantive signals that must NOT be ignored:
- Explicit: "remember this", "from now on", "always", "never", "please note"
- Preference: "I prefer X", "I always use X", "I never do X", "my preference is X"
- Repeated fact (appears ≥2 times across turns — the caller has already determined this)

When in doubt, prefer "ignore" for casual one-liners. Prefer "add" for clear new facts.
Return JSON only.`;

function buildUserPrompt(
  turn: Turn,
  candidate: string,
  existing: MemoryEntry[],
  repetitionCount: number,
): string {
  const existingBlock =
    existing.length === 0
      ? 'none'
      : existing.map((e) => `id=${e.id} scope=${e.scope} content="${e.content}"`).join('\n');

  return [
    `Turn text: "${turn.text}"`,
    `Candidate memory: "${candidate}"`,
    `Times this candidate has appeared across recent turns: ${repetitionCount}`,
    `Existing memories for this scope:`,
    existingBlock,
  ].join('\n');
}

/** Output shape returned by the provider (parsed from JSON). */
interface ClassifierOutput {
  decision: ChangePolicyDecision;
  reason: string;
  existing_id: string | null;
}

function parseOutput(raw: string): ClassifierOutput {
  // Strip any markdown fences if the model wraps it.
  const cleaned = raw
    .replace(/```json?\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`classifier: failed to parse provider output as JSON: ${raw}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`classifier: expected JSON object, got: ${raw}`);
  }
  const obj = parsed as Record<string, unknown>;
  const decision = obj['decision'];
  if (
    decision !== 'add' &&
    decision !== 'update' &&
    decision !== 'supersede' &&
    decision !== 'ignore'
  ) {
    throw new Error(`classifier: unrecognized decision "${String(decision)}"`);
  }
  return {
    decision: decision as ChangePolicyDecision,
    reason: typeof obj['reason'] === 'string' ? obj['reason'] : '',
    existing_id: typeof obj['existing_id'] === 'string' ? obj['existing_id'] : null,
  };
}

/** The result of `classify`, including supporting context for the writer. */
export interface ClassifyResult {
  decision: ChangePolicyDecision;
  /** The `MemoryEntry.id` of the existing row to update or supersede, if any. */
  existingId?: string;
  /** One-sentence rationale from the model. */
  reason: string;
}

/**
 * Classify whether a candidate memory fact should be added, update an existing
 * entry, supersede an existing entry, or be ignored.
 *
 * @param turn            - The current conversation turn (provides text + context).
 * @param candidate       - The candidate memory string (extracted by the kernel).
 * @param existing        - Active memory entries already stored for the relevant scope.
 * @param provider        - Injected provider (never read from env here).
 * @param repetitionCount - How many times this candidate has appeared across recent
 *                          turns. Caller supplies; default 1 (first mention).
 */
export async function classify(
  turn: Turn,
  candidate: string,
  existing: MemoryEntry[],
  provider: ProviderInterface,
  repetitionCount = 1,
): Promise<ClassifyResult> {
  // Fast-path: heuristic pre-check before spending a provider call.
  // If the candidate is very short and lacks substantive signals, skip early.
  const lowerCandidate = candidate.toLowerCase();
  const lowerText = turn.text.toLowerCase();

  const hasExplicitSignal =
    /\b(remember\s+(this|that)|from\s+now\s+on|always\s+|never\s+|please\s+note|note\s+that)\b/i.test(
      lowerText,
    );
  const hasPreferenceSignal =
    /\b(i\s+prefer|my\s+preference|i\s+always|i\s+never|i\s+like\s+to|i\s+hate|i\s+dislike)\b/i.test(
      lowerText,
    );

  // A single short casual mention without signals is pre-classified as ignore.
  // The model still gets called if signals are present or repetition ≥ 2.
  const likelyCasual =
    !hasExplicitSignal &&
    !hasPreferenceSignal &&
    repetitionCount < 2 &&
    lowerCandidate.split(/\s+/).length < 4;

  if (likelyCasual) {
    return { decision: 'ignore', reason: 'pre-classified: too short, no signal, first mention' };
  }

  const userPrompt = buildUserPrompt(turn, candidate, existing, repetitionCount);

  // Collect the full response from the streaming provider.
  let fullContent = '';
  for await (const chunk of provider.complete({
    model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', // default; caller should inject configured model
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    maxTokens: 256,
  })) {
    if (chunk.delta.content) {
      fullContent += chunk.delta.content;
    }
  }

  const output = parseOutput(fullContent);

  const result: ClassifyResult = {
    decision: output.decision,
    reason: output.reason,
  };
  if (output.existing_id != null) {
    result.existingId = output.existing_id;
  }
  return result;
}
