// Replay the context Eve supplies on the first turn in an existing Slack thread. These are
// test-owned snapshots, not instructions for the brain to repeat or facts about a live job.
export function afterFinishedJob(message: string): string {
  return `<slack_thread_context>
<@UOWNER1>: In example-app, add retries and open a draft PR.
<@UBOT>: J-12 is done. Draft PR #42: https://example.com/example-app/pull/42.
Tests passed, including 4 new tests. Production is unchanged.
One concern: retry waits can add 6 minutes to a full sync. The wait is not capped.
</slack_thread_context>

${message}`;
}

// Deliberately narrow: lists, code, tables, and quotes can fit other answers. This detects
// report headings and checklists when a quick conversational answer was requested.
export function isQuickReply(value: unknown): boolean {
  const text = String(value ?? "").trim();
  const report =
    /^(?:#{1,6}\s|\*{0,2}(?:tl;dr|summary|status|result|checks|open questions|next steps)\*{0,2}\s*[:\n]|[-*]\s+\[[ x]\]|[☐☑✅])/im;
  return text.length > 0 && !report.test(text);
}
