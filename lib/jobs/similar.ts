// Near-duplicate text for result messages. Pure, with no Node builtins, because the workflow
// bundle reaches it. Two lines repeat when they carry the same words after case, punctuation, and
// stop words are ignored.

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "in",
  "on",
  "for",
  "and",
  "or",
  "it",
  "its",
  "this",
  "that",
  "with",
  "by",
  "at",
  "as",
  "so",
  "but",
  "did",
  "does",
  "do",
  "has",
  "have",
  "had",
  "from",
  "there",
  "any",
]);

/** Share of words two lines must have in common to count as the same line. */
const OVERLAP = 0.75;
/** A line with at least this many words is a repeat when a longer line holds all of its words. */
const SUBSET_MIN_WORDS = 3;

export function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/n't\b/g, " not")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word !== "" && !STOP_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
  return new Set(words);
}

export function nearDuplicate(a: string, b: string): boolean {
  const left = significantWords(a);
  const right = significantWords(b);
  if (left.size === 0 || right.size === 0) return false;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared += 1;
  if (shared === small.size && small.size >= SUBSET_MIN_WORDS) return true;
  return shared / (left.size + right.size - shared) >= OVERLAP;
}
