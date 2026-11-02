// The cheap checks before a trigger fires (decision 088). They only narrow which events reach the
// brain; the brain still decides from the instruction whether an event needs anything.

// True when the text has one of the keywords as a whole word or phrase, ignoring case. No
// keywords match every message.
export function matchesKeywords(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const haystack = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return keywords.some((keyword) => {
    const needle = keyword
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

// An emoji name as Slack sends it in `reaction_added`: no colons, no skin tone, lowercase.
export function normalizeEmoji(name: string): string {
  return name
    .trim()
    .replace(/^:+|:+$/g, "")
    .replace(/::skin-tone-\d$/, "")
    .toLowerCase();
}
