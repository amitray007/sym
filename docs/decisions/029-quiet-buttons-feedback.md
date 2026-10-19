# 029. Quiet mode, the slash command, card buttons, and feedback

Status: accepted
Date: 2026-10-20

## Context

The display rule has a quiet modifier (docs/display.md), the job card shows Stop and Open PR
(docs/slack.md), and the learning loop starts with feedback (docs/learning.md). None of them may
need a model call, and none may let someone outside the allow-list act.

## Decision

The ledger `settings` and `feedback` tables (migration 005) hold the owner's `quiet_until` and
the feedback signals. `isQuiet` combines `/sym quiet` with the pack's quiet hours in its time zone,
and every post Sym makes passes that to `chooseDisplay`. The Slack channel handles `/sym status`,
`/sym jobs`, and `/sym quiet` in `onSlashCommand` with ephemeral answers. The live card has a
Stop button (`sym_job_stop`, confirmed) and an Open PR URL button; `onInteraction` stops the job
for allowed users only. A renderer adds feedback buttons under Eve's final replies, and
`onEvent` records reactions on Sym's own messages.

## Consequences

Quiet mode never hides a needed action or a failure. The feedback buttons are a separate message
under each reply, because the reply is Eve's, not Sym's; if that proves noisy, the owner can turn
it off in a later step. Steering from a button needs a modal and comes later.
