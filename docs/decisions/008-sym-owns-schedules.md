# 008. Sym owns schedules, not the worker

Status: accepted
Date: 2026-10-19

## Context

T3 Code has its own scheduler, but Sym would only discover those runs afterwards.

## Decision

Schedules are Postgres rows that Sym's `dispatch` schedule fires every minute with a lease per row. Each fire opens a Slack thread and calls the job tool with the stored brief.

## Consequences

Sym knows each run before it starts, so it can open the thread, record the job, and choose the display level. Approval of the schedule row covers every fire.
