# 005. Sym owns one job card per long job

Status: accepted
Date: 2026-10-19

## Context

Eve's task card shows a row per task with no progress inside it, and schedule sessions get no card. Progress posts as new messages would notify on every step.

## Decision

Each long job gets one Slack `plan` block message that Sym posts and edits with `chat.update`. Its `ts` lives on the job row. A `taskCard` renderer hides Eve's card for `t3_job` tasks.

## Consequences

Progress is silent because edits do not notify. The card works for scheduled jobs and after session loss. Milestone 1 confirms `plan` status values and `chat.update` rate limits.
