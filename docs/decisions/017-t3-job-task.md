# 017. `t3_job` is a task with ledger-backed steps

Status: accepted
Date: 2026-10-19

## Context

A worker job runs for minutes to hours. Eve can retry a workflow tool start, so two runs can
execute. Steps can retry, and the workflow body replays after each durable wait. T3 has no retry
key for a launch.

## Decision

`agent/tools/t3_job.ts` is a `defineWorkflowTool` with a `task` entry, so the conversation stays
open while the worker runs. The owner starts each job from the brief (decision 021). Its steps
call plain functions in `lib/jobs/run.ts`:

- `recordJob` inserts the job row keyed on the session ID and the replay-stable tool call ID (a
  call ID is unique only inside its session), so a re-run returns the
  same row.
- `launchOrAdopt` returns the stored thread, or finds one whose title holds `[J-<id>]`, and
  launches only when neither exists.
- `checkJob` waits up to 60 seconds on the worker, reads activity from the stored cursor, and
  records status, cursor, and summary.

`launchOrAdopt` holds a Postgres advisory lock per job, so two copies of one call cannot both
launch. The thread lookup matches the title prefix, so a title that mentions another job cannot
adopt that job's thread. `checkJob` reads every new page of activity and keeps the newest worker
message on the job row, because the final message can arrive one check before the final status.

The body races the worker's callback webhook, a 4-minute durable sleep, and the call's abort
signal, then checks. A body parked on a sleep does not see an abort on its own, so the race is
needed. On abort it interrupts the worker thread and records the job as `cancelled`. If any step
fails for good, the body records the job as `failed` before it rethrows. A finished job keeps its
status: a stale update cannot move it back to running. Each check yields a status line of at most
50 characters. The task returns the job reference, final status, summary, and the worker's last
message.

## Consequences

The job logic is tested with a fake worker and a real Postgres, without Eve's runtime. A job row
has everything a new session needs to continue. Questions, permission prompts, the job card, and
result checks come in later steps.
