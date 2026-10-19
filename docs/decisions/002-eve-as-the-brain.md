# 002. Eve is the brain

Status: accepted
Date: 2026-10-19

## Context

Sym needs a Slack channel, durable long-running tasks, approvals, schedules, memory hooks, and evals. Building these from scratch would take most of the effort.

## Decision

Sym runs on Eve (npm `eve`, Apache-2.0), self-hosted with `eve build` and `eve start`. Sym pins the Eve version.

## Consequences

Eve's limits become Sym's limits: HTTP Events API only, no session survival across self-hosted upgrades, no exactly-once delivery. The ledger (decision 004) and reconcile cover the gaps. See `docs/eve.md`.
