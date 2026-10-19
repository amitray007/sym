# 004. The Postgres ledger is the source of truth

Status: accepted
Date: 2026-10-19

## Context

Eve sessions end on upgrades, crashes, and timeouts. A job on a worker can run for an hour or more.

## Decision

Every job, schedule, outbound post, and feedback signal is a Postgres row. A job row holds the worker thread ID, a read cursor, the last summary, and the job card `ts`. Reconcile compares the ledger with each worker every 3 minutes.

## Consequences

A job continues in a new session after its Slack session dies. "What's running?" is a database read. Posts go through an outbox with idempotency keys.
