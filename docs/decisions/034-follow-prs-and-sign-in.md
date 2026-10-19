# 034. Reconcile follows pull requests and the worker sign-in

Status: accepted
Date: 2026-10-20

## Context

A PR outlives its job: CI fails and reviewers comment after the result posts (docs/architecture.md,
flow 4). The worker sign-in has no refresh token and ends after 30 days (docs/workers.md).

## Decision

When a job ends with a PR, reconcile asks the worker to watch it once (T3 `watch_pull_request`,
which needs access above read-only). T3 wakes the worker thread on CI results, reviews, and merge
conflicts; reconcile reads those wakes for 7 days and posts each one once in the job thread. The
reconcile schedule also reads `T3_TOKEN_EXPIRES_AT` and DMs the owner the re-approve step 5 days
before the sign-in ends and once after, keyed by date and stage. The owner is the pack owner, else
`SYM_OWNER_SLACK_USER`.

## Consequences

The owner hears about a failing PR in the job thread without asking. A settled or archived worker
thread stops getting wakes. A missed sign-in renewal shows up days ahead.
