# 020. The ledger holds the job card, and delivery syncs it

Status: accepted
Date: 2026-10-20

## Context

A job card must keep updating after the session that started the job dies, and the job thread
must get one message at the start and one at the end (docs/milestone-1.md). Eve's tools and
schedules cannot read the Slack channel's session state, so they do not know which thread a job
belongs to. Eve's own task card shows no progress inside a job.

## Decision

A Slack renderer records each session's channel, thread, and triggering user in the
`session_threads` table at `turn.started`. A job copies them when it is recorded. The job row
holds the card Sym wants (`card`, `card_version`) and the version Slack shows
(`card_sent_version`). `lib/jobs/present.ts` decides every post with `chooseDisplay` and
enqueues it with an idempotency key. `lib/delivery/deliver.ts` claims outbox posts with a lease,
sends them through the `SlackApi` seam, saves the card's `ts`, and edits a card whose wanted
version is newer. The card's `block_id` carries its version, and the version moves only when the
card changes. Job steps deliver right after they enqueue, and a schedule delivers every minute
as the safety net. The renderer hides Eve's task card for `t3_job`.

## Consequences

Any process can bring Slack up to date from the ledger: the task, reconcile, or the delivery
schedule. A PR opened mid-job posts once; at the end the result message carries the PR, so the
thread gets one end message. Slack posts stay at least once: a crash after Slack answers and
before the outbox row is marked sent posts again.
