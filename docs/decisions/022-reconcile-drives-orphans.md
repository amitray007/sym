# 022. Reconcile drives orphaned jobs in code

Status: accepted
Date: 2026-10-20

## Context

A `t3_job` task can stop watching its job: the session dies, an Eve upgrade strands it, or the
process restarts. The design said reconcile starts a recovery session in the job thread. A
recovery session needs a model turn and a person-facing session for work that is plain code.

## Decision

Each check renews a watcher lease on the job row (`watch_until`, 10 minutes, longer than the
4-minute poll). Every 3 minutes, the reconcile schedule takes the active, launched jobs whose
lease ran out and runs the same `checkJob` a task runs. The job then gets its card edits, events,
and result message as usual. When the worker does not answer, reconcile marks the job
`worker_offline` and posts once, and posts once more when the worker is back. A worker question
that reconcile finds posts once in the thread, with the worker thread ID, because no task can
show buttons.

## Consequences

Recovery needs no model call. Two watchers can check one job at the same time; checks are
idempotent and posts carry idempotency keys, so this is safe. Answering a question for an
orphaned job happens on the worker until a recovery session exists.
