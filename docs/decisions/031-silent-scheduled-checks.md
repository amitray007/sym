# 031. A clean scheduled check posts nothing

Status: accepted
Date: 2026-10-20

## Context

Milestone 1 exit criterion 6 says a clean scheduled check posts nothing, and the display rule
says nothing new means silence (docs/display.md, step 2). A scheduled job that posts a thread
root, a brief, a card, and a result every morning would teach the owner to ignore Sym.

## Decision

The dispatcher opens a session in the schedule's channel with no root message. A job from an
approved schedule (decision 024) is marked `scheduled-check`. It posts no brief, no card, and no
start line, and mid-run PR and quiet notices are skipped. At the end it posts one message only
when something needs attention: the job failed, the result block is missing, it lists open
questions, or a result check found a rule break. A clean check posts nothing, and its run row is
`all_clear` for the digest. The run outcome and the posting decision use the same checks, so the
digest and Slack agree. A permission prompt still DMs the owner.

## Consequences

The owner hears about a scheduled check only when it matters, plus one line in the evening
digest. A message that needs attention opens the thread, so follow-ups land in it.
