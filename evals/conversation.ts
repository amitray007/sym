// Replay the context Eve supplies on the first turn in an existing Slack thread, plus the job
// note the Slack channel adds there (agent/channels/slack.ts). These are test-owned snapshots,
// not instructions for the brain to repeat or facts about a live job.
export function afterFinishedJob(message: string): string {
  return `<slack_thread_context>
<@UOWNER1>: In example-app, add retries and open a draft PR.
<@UBOT>: Done. Draft PR #42: https://example.com/example-app/pull/42.
Tests passed, including 4 new tests. Production is unchanged.
One concern: retry waits can add 6 minutes to a full sync. The wait is not capped.
</slack_thread_context>

This conversation is about J-12 ("Add retries to example-app"), now done. Job and schedule references are handles for tools; never write them to people. Name the work in a few words, or say "this" here.

${message}`;
}

// Deliberately narrow: lists, code, tables, and quotes can fit other answers. This detects
// report headings and checklists when a quick conversational answer was requested.
export function isQuickReply(value: unknown): boolean {
  const text = String(value ?? "").trim();
  const report =
    /^(?:#{1,6}\s|\*{0,2}(?:tl;dr|summary|status|result|checks|open questions|next steps)\*{0,2}\s*[:\n]|[-*]\s+\[[ x]\]|[☐☑✅])/im;
  // A quick reply fits in a few short lines (decision 093), not a wall of text.
  const lines = text.split("\n").filter((line) => line.trim() !== "").length;
  return text.length > 0 && text.length <= 600 && lines <= 6 && !report.test(text);
}

// Stock assistant phrases the Voice rules ban (decision 093). Narrow on purpose: a match is a
// clear bot tell, not a judgment of tone.
const BOT_PHRASES =
  /\b(?:let me know if (?:you need|there's) anything|how can i help|happy to help|i'?d be happy to|great question|hope this helps|i apologi[sz]e for the confusion|no problem at all|anything else i can)\b/i;

export function hasNoBotPhrases(value: unknown): boolean {
  return !BOT_PHRASES.test(String(value ?? ""));
}

type ApprovingSession = {
  readonly pendingInteractions: readonly unknown[];
  respondAll(optionId: string): Promise<unknown>;
};

// An eval session has no Slack thread, so Sym can't tell that the conversation is public and
// asks before a post or a DM, as it does from a private conversation (decisions 082 and 083).
// The eval's person approves, like the requester would. These cases check routing, not the gate.
export async function approvePending(session: ApprovingSession): Promise<void> {
  while (session.pendingInteractions.length > 0) await session.respondAll("approve");
}
