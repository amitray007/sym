# 030. The pack shapes each launch, and results get rule checks

Status: accepted
Date: 2026-10-20

## Context

A pack lists the projects a worker may use, their paths, base branches, and PR policy (decision
026). Flow 4 runs deterministic checks before any model review (docs/architecture.md).

## Decision

With a pack, the launch step refuses a project the pack does not list, uses the pack's worker
project, base branch, and guardrails, and turns a requested PR off when the project allows none.
The pack also decides the Slack allow-list. When a job ends, `lib/jobs/verify.ts` compares the
worker's output contract with the rules: files changed outside the allowed paths, and a PR the
job did not allow. Breaks show under "Check before you merge" in the result message. The pack
loads once per process, outside the workflow bundle, and reaches the job steps through their
dependencies.

## Consequences

A brief can never widen a pack's rules. The checks trust the worker's own list of changed files;
checking the real diff and CI status needs the worker or GitHub and comes later.
