# 021. The owner starts each job from the brief

Status: accepted. Decision 060 shortens the brief post; the full brief is behind a button.
Date: 2026-10-20

## Context

A job that can write code needs an approval (AGENTS.md). Eve's `approval: always()` shows
approve and deny for the raw tool input, with no way to edit. Milestone 1 asks for a brief with
Start, Edit, and Cancel.

## Decision

`t3_job` records the job and posts the full brief as Sym's own message in the job thread,
because Eve's prompt card keeps only about 200 characters. Then it asks with `ctx.ask`: "Start
J-142: title?" with Start, Edit, and Cancel buttons. Start launches. Cancel ends the job before
it starts. Edit asks a second, free-text question for the changes; a plain reply in the thread
answers it. The job then ends, and the edits go back to the model, which writes a new brief and
calls `t3_job` again. A session that cannot ask a person, such as a schedule session, gets
`unavailable`, and the job does not start. Worker questions use the same `ctx.ask`, one Slack
prompt per question, with the options as buttons and free text for other answers. The Slack
channel's `onInputResponse` accepts answers only from allowed users.

## Consequences

Every job start has a human decision on record in the session. The tool has no `approval`
policy of its own. Scheduled jobs need the trust ladder (a later step) before they can start
without a person.
