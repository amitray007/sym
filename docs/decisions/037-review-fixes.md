# 037. Fixes from the first independent review

Status: accepted
Date: 2026-10-20

## Context

An independent review by a different model family read the job core, delivery, schedules, the
pack, and approvals on `main` and found 15 defects. Several could run a job on the wrong worker,
widen a brief, lose a result, or let someone other than the owner approve.

## Decision

- Routing and rules: a pack project on another worker is refused (`JobDeps.workerName`), and a
  draft PR needs both the pack's policy and the brief's request.
- Owner decisions: tool approvals count only from the owner, and the playbook tools check the
  owner too. Questions stay open to allowed users.
- Concurrency: launch-lock reads and writes use the reserved connection; a check commits only
  while the job's cursor is the one it read; card edits are serialized per job; a card post and
  its ts are recorded in one statement.
- Recovery: a failed watcher hands a launched job to reconcile instead of failing it; reconcile
  posts any end message that a crash never queued.
- Schedules: a dispatch reserves a unique run before it sends, a claim completes only under its
  own lease, and pre-approval claims that session's run for one job.
- Input checks: worker paths are normalized before the allowed-path check, pack files must stay
  inside the pack on their real paths, steering keys come from the tool call, and cron keeps
  wildcard meaning for `*/n` day fields.

## Consequences

Each fix has a test. The review is repeatable: run it again after large changes to the job core.
