// What makes a Slack reply a wall of text (decision 103). The check reads only prose: code blocks,
// table rows, and quotes keep their own shape. It is a cheap gate for the rewrite pass and the
// floor the voice evals share, not a judgment of tone.

// A line longer than this wraps past two rows in a Slack thread.
export const MAX_LINE = 160;
// About six short lines (decision 093).
const MAX_PROSE = 800;
// More numbers than this on one line reads as a metrics dump.
const MAX_NUMBERS_PER_LINE = 4;

const NUMBER = /\d+(?:[.,:]\d+)*/g;
const URL = /<?https?:\/\/[^\s>|]*[^\s>|.,;:!?)]/g;

export function readabilityProblems(text: string): string[] {
  const lines = proseLines(text);
  const problems: string[] = [];
  const long = lines.filter((line) => line.length > MAX_LINE).length;
  if (long > 0) problems.push(`${long} line(s) over ${MAX_LINE} characters`);
  const dense = lines.filter((line) => numbersIn(line) > MAX_NUMBERS_PER_LINE).length;
  if (dense > 0) problems.push(`${dense} line(s) with more than ${MAX_NUMBERS_PER_LINE} numbers`);
  const prose = lines.join("\n").length;
  if (prose > MAX_PROSE) problems.push(`${prose} characters of prose, over ${MAX_PROSE}`);
  return problems;
}

export const isReadable = (text: string) => readabilityProblems(text).length === 0;

// A rewrite may drop detail, but it must not add or change a fact: every number in it must
// appear in the original, and every link in the original must survive.
export function keepsFacts(original: string, rewrite: string): boolean {
  const before = new Set(tokens(original, NUMBER));
  if (!tokens(rewrite, NUMBER).every((n) => before.has(n))) return false;
  const after = new Set(tokens(rewrite, URL));
  return tokens(original, URL).every((url) => after.has(url));
}

function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    const line = raw.trim();
    if (fenced || line === "" || line.startsWith("|") || line.startsWith(">")) continue;
    lines.push(line.replace(URL, "link"));
  }
  return lines;
}

const numbersIn = (line: string) => line.match(NUMBER)?.length ?? 0;
const tokens = (text: string, pattern: RegExp) =>
  (text.match(pattern) ?? []).map((t) => t.replace(/^</, "").toLowerCase());
