# 032. A verifier subagent checks code results before they post

Status: accepted
Date: 2026-10-20

## Context

Flow 4 runs the rule checks first, then a model check that compares the done-when list with the
worker's claims (docs/architecture.md). Eve can call a declared subagent from a workflow body
with `ctx.agent(name).send(message, { outputSchema })`. The body cannot call it from a step, and
reconcile has no body at all. A job must still finish after its session dies (decision 004).

## Decision

`agent/subagents/verifier/` is a declared subagent with `tool: false` and no tools, so only
`t3_job` calls it and it cannot change anything. It uses the brain's model selection
(`SYM_MODEL`). With `fixture`, a scripted verifier (`lib/brain/fixture-verifier.ts`) returns pass
when the rule checks found nothing and concerns otherwise.

When the worker finishes a code job, `checkJob` moves it to `checking` instead of `done`, and the
card shows "Check result" in progress. The `t3_job` body sends the verifier the brief, the rule
check concerns, and the worker's result. The worker text sits in a tag marked as untrusted data.
The verifier returns `{ verdict, concerns, confidence }`. The step `finishJob` then sets `done`,
collapses the card, and posts the one result message with a verdict line. The rule-check concerns
and the verifier's concerns show once each under "Check before you merge". The schedule run
outcome uses the same list.

The model check is skipped, and the result posts with the rule checks alone, in four cases:

- Reconcile finishes an orphaned job, including one left in `checking`.
- A scheduled check (decision 031) stays cheap and silent.
- The task is stopped or fails while the job is in `checking`. The work is done, so the job ends
  as `done`, not `cancelled` or `failed`.
- The verifier fails, returns a wrong shape, or takes more than 5 minutes. The result then says
  "Model check unavailable".

## Consequences

A code result reaches Slack one model call later, and that call uses the parent's token budget.
The verifier sees the worker's claims, not the diff, so it judges evidence, not code. Checking
the real diff and CI needs the worker or GitHub and comes later. A verifier timeout stays below
the watcher lease, so reconcile does not finish a job the task still checks.
