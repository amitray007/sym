# 024. Schedules are approved rows behind one dispatcher

Status: accepted
Date: 2026-10-20

## Context

The owner asks Sym for recurring checks in plain words (decision 008). Eve schedules are code,
fixed at build time. A recurring job must not fire twice, and the owner must approve it once.

## Decision

Each owner schedule is a row in `schedules` (migration 003): cron in UTC, title, the stored brief,
the channel, the owner, status, and a lease. `schedule_create` shows the row in an approval prompt
and saves it as active only after approval. The `dispatch` schedule runs every minute, claims due
active rows with `for update skip locked` and a lease, opens a new Slack thread for each, and
records a `schedule_runs` row. Sym parses cron itself (`lib/schedules/cron.ts`), with no
dependency. A failed dispatch skips that fire instead of retrying. The `digest` schedule posts the
day's jobs and schedule runs through the outbox, once per day, to `SYM_DIGEST_CHANNEL`.

## Consequences

A schedule fires at most once per due time, even with an overlapping process. A job from an
approved schedule skips the Start prompt only when the session was started by the dispatcher and
the brief equals the approved one; any other job still asks.
