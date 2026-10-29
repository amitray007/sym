# 068. The brain knows its capabilities, and can open a code channel on request

Status: accepted
Date: 2026-10-29

## Context

With code channels on, a person asked Sym in Slack whether it could create code channels. The
brain said no. Its instructions never named the feature, because the move to a code channel
happens in code when a person clicks Start (decision 067). A brain that does not know a feature
denies it. It can also offer features that are off.

A person may also ask for a code channel outside a worker job. Eve 0.88 provides
`openCodeChannel()` for that.

## Decision

1. A dynamic instruction, `agent/instructions/capabilities.ts`, tells the brain which opt-in
   features this deployment has on: code channels, the verifier, PR follow, and the daily digest.
   Each line reads the same switch as the code, so it is never stale. The lines describe what a
   person sees, not how the code does it. Worker threads get none.
2. With `SYM_CODE_CHANNELS` on, the brain has a `code_channel` tool. It moves the current
   conversation into a new code channel through Eve's `openCodeChannel()`. A code channel opens in
   two cases only: a person explicitly asks for one, or a person starts a worker job. The brain
   never opens one on its own, not even for long or multi-step work. Eve copies the
   conversation, matches the thread's privacy, and continues the session there. The tool returns
   Slack's refusal as text, and the brain answers in the thread. With the switch off, the tool does
   not exist.
3. A worker job started inside a code channel takes that channel instead of opening another. Its
   row keeps the channel, has no thread and no origin, and `code_channel` is true. Its status,
   context bar, and Close archive work as for a moved job; the archive has no summary to share.

## Consequences

- The brain may open a channel for a conversation, so a channel no longer always means one job.
  The job note on each turn names the newest job in the channel, if any.
- A code channel that another agent app owns is adopted the same way when a job starts there. Slack
  refuses Sym's status and archive calls in it; Sym logs the error, and Close posts a retry button.
