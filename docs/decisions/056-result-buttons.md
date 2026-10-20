# 056. Result buttons, follow-up jobs, and the Steer box

Status: accepted
Date: 2026-10-21

## Context

The result message had only Open PR, and steering needed a typed thread reply. The design
(docs/mockups) shows Looks good, Fix, and Close on the result and a Steer button on the card. Eve
0.81 passes a button's `trigger_id` to Sym, but it drops every `view_submission` except its own
freeform answer modal, so a custom modal cannot reach Sym's code.

## Decision

1. The live card has Steer, Stop, and Open PR. A result has Open PR, Looks good, Fix…, and Close;
   a failure has Fix… and Close. A cancelled job has none. Allowed users can use them all.
2. Steer and Fix… post a text box in the job thread: a message `input` block with
   `dispatch_action`, whose block ID carries the job reference. Enter sends a `block_actions`
   payload with the text, which Eve passes to `onInteraction`. The box is then edited into the
   person's words and Sym's answer. A modal can replace the box when Eve passes custom
   submissions.
3. Fix starts a follow-up job instead of reopening the finished one. The new row copies the
   parent's worker thread, cursor, brief (with the follow-up text added to the goal), and PR
   watch, and records `parent_job_id`. Sym sends the text to the thread with the parent's limits
   restated. No task watches the follow-up. A one-minute lease keeps reconcile away until the
   send lands; after that, reconcile drives it to its own card and result, with the rule checks.
   Reconcile now holds a job's watch for two minutes, less than its three-minute interval, so it
   checks such a job on every pass. A `fix` feedback row records the words on the parent.
   Once a follow-up continues a thread, the parent refuses Fix and Close; the newest job on the
   thread owns its buttons.
4. Migration `018_job_followups` adds `parent_job_id`, `closed_at`, and `closed_by`, and replaces
   the one-job-per-thread index with one active job per thread. A Fix while another job works in
   the thread is refused; the person steers that job instead.
5. Close records who closed the job, calls the adapter's optional `settle` (T3
   `t3_thread_organize` with `settle`), and edits the result: the Looks good, Fix, and Close
   buttons go, and a "Closed by" line follows. PR follow skips closed jobs and jobs whose thread a
   later follow-up took over.
6. Looks good records a `thumbs_up` row with the value `looks_good`, once per person and result.

## Consequences

A finished job never changes state again, so the ledger keeps one result per job. A Fix needs no
new Start. The approval rule asks for a person's yes before code changes, and a Start click is
that yes from any allowed user. A Fix is the same: an allowed user types the change and presses
Enter on their own words, and the brief's limits still apply. A follow-up reports after the next
reconcile pass, at most about three minutes after the worker finishes, and gets no model check. Fix text is the first source of `fix` feedback, so
the weekly learn pass can now group repeated fixes. The live run with the test Slack app checks
that Slack renders an input block in a message.
