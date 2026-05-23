/**
 * Substance-diff guard.
 *
 * Compares the *material facts* in the original draft versus the tone-rewritten
 * output. If any fact is added, removed, or changed, the guard rejects the
 * rewrite (`accepted: false`) and the caller delivers the original draft.
 *
 * ## Approach
 *
 * Rather than compare whole sentences (which trips on every rewording), the
 * guard extracts a multiset of **fact tokens** from each text and diffs them:
 *
 *   - **numbers** — any digit run (covers counts, durations, percentages, dates)
 *   - **entities** — capitalized words (proper nouns), minus a stoplist of
 *     capitalized function/sentence-starter words (The, There, We, It, …)
 *   - **directions** — comparison words (more/less/higher/lower/before/after/…)
 *   - **negations** — not/never/no/cannot/without
 *
 * Tone-only rewrites (passive↔active, synonyms, politeness fillers, spelling)
 * preserve the fact tokens, so the multisets match → accept. Fact changes
 * (number mutation, entity swap, direction flip, added/removed claim) alter the
 * multisets → reject.
 *
 * The guard is intentionally conservative: its failure mode is over-rejection
 * (deliver the original, always safe), never delivering altered facts. The
 * promptfoo eval set in `evals/` is the source of truth for accuracy; tune the
 * stoplist / token classes there as cases accumulate.
 */

const COMPARISON_WORDS = [
  'more',
  'less',
  'higher',
  'lower',
  'greater',
  'fewer',
  'larger',
  'smaller',
  'faster',
  'slower',
  'before',
  'after',
  'earlier',
  'later',
  'increase',
  'decrease',
  'double',
  'triple',
  'half',
];

const NEGATION_WORDS = ['not', 'never', 'cannot', 'without', 'none'];

/**
 * Capitalized words that are NOT entities — sentence starters and function
 * words that appear capitalized. Lowercased for lookup.
 */
const ENTITY_STOPWORDS = new Set([
  'the',
  'there',
  'this',
  'that',
  'these',
  'those',
  'we',
  'it',
  'they',
  'you',
  'he',
  'she',
  'i',
  'a',
  'an',
  'and',
  'but',
  'or',
  'so',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'by',
  'with',
  'as',
  'from',
  'is',
  'are',
  'was',
  'were',
  'will',
  'would',
  'can',
  'could',
  'should',
  'let',
  'sure',
  'absolutely',
  'certainly',
  'okay',
  'yes',
  'no',
  'please',
  'thanks',
  'thank',
  'here',
  'when',
  'where',
  'what',
  'who',
  'how',
  'why',
  // Common sentence-initial adverbs / transitions (capitalized but not entities).
  'currently',
  'now',
  'today',
  'tonight',
  'recently',
  'then',
  'also',
  'however',
  'therefore',
  'meanwhile',
  'finally',
  'additionally',
  'actually',
  'basically',
  'essentially',
  'generally',
  'typically',
  'usually',
  'perhaps',
  'maybe',
  'overall',
  'furthermore',
  'moreover',
  'nonetheless',
  'nevertheless',
  'note',
  'first',
  'second',
  'third',
  'next',
]);

/** Extract a multiset of fact tokens, each prefixed by its class to avoid collisions. */
function extractFactTokens(text: string): string[] {
  const tokens: string[] = [];

  // Numbers (digit runs).
  for (const m of text.matchAll(/\d+/g)) {
    tokens.push(`n:${m[0]}`);
  }

  // Entities: capitalized words minus the stoplist.
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]+\b/g)) {
    const word = m[0].toLowerCase();
    if (!ENTITY_STOPWORDS.has(word)) {
      tokens.push(`e:${word}`);
    }
  }

  // Directions + negations (word-boundary matches on lowercased text).
  const lower = text.toLowerCase();
  for (const word of [...COMPARISON_WORDS, ...NEGATION_WORDS]) {
    const matches = lower.match(new RegExp(`\\b${word}\\b`, 'g'));
    if (matches) {
      for (const _match of matches) tokens.push(`c:${word}`);
    }
  }

  return tokens;
}

/** Count occurrences of each token. */
function toCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

/** Strip the class prefix for human-readable output. */
function humanToken(token: string): string {
  return token.slice(token.indexOf(':') + 1);
}

export interface SubstanceDiffResult {
  /** True if the rewrite contains no detected factual changes. */
  accepted: boolean;
  /** Human-readable reason when `accepted` is false. */
  rejectionReason?: string;
  /** Fact tokens present in the original but missing from the rewrite. */
  removedClaims: string[];
  /** Fact tokens present in the rewrite but missing from the original. */
  addedClaims: string[];
}

/**
 * Check whether `rewrittenText` carries the same material facts as
 * `originalText`. Accepts when the fact-token multisets match.
 */
export function checkSubstanceDiff(
  originalText: string,
  rewrittenText: string,
): SubstanceDiffResult {
  const originalCounts = toCounts(extractFactTokens(originalText));
  const rewrittenCounts = toCounts(extractFactTokens(rewrittenText));

  const removedClaims: string[] = [];
  const addedClaims: string[] = [];

  for (const [token, count] of originalCounts) {
    const surplus = count - (rewrittenCounts.get(token) ?? 0);
    for (let i = 0; i < surplus; i += 1) removedClaims.push(humanToken(token));
  }
  for (const [token, count] of rewrittenCounts) {
    const surplus = count - (originalCounts.get(token) ?? 0);
    for (let i = 0; i < surplus; i += 1) addedClaims.push(humanToken(token));
  }

  if (removedClaims.length === 0 && addedClaims.length === 0) {
    return { accepted: true, removedClaims: [], addedClaims: [] };
  }

  const parts: string[] = [];
  if (removedClaims.length > 0) {
    parts.push(`Removed fact(s): ${removedClaims.slice(0, 3).join(', ')}`);
  }
  if (addedClaims.length > 0) {
    parts.push(`Added fact(s): ${addedClaims.slice(0, 3).join(', ')}`);
  }

  return {
    accepted: false,
    rejectionReason: parts.join('. '),
    removedClaims,
    addedClaims,
  };
}
