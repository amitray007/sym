# 041. The brain picks a worker model per job from an allow-list

Status: accepted
Date: 2026-10-20

## Context

Sym ran every worker thread on one model, set by `SYM_WORKER_MODEL`. Jobs differ. A docs fix does
not need the strongest model. A migration or a security change does. A scheduled read-only check
should be cheap. The owner also wants to see the choice before pressing Start.

## Decision

Each worker has a model list. Every entry has an ID (`<provider>/<model>`, where the provider is the
T3 provider instance ID), a `use` line, an optional `effort`, and an optional `default` flag.
The pack sets the list in `sym.config.yaml` under `workers[].models`. Without it, a built-in list
applies (`lib/workers/models.ts`): Claude Sonnet (default), Claude Opus, and two Codex models, each
with a purpose. `SYM_WORKER_MODEL` stays and becomes the default entry. Sym adds it to the list
when the list lacks it.

The brain reads the list in a dynamic instruction. It may set `model` and `modelReason` on the
brief. The brief message shows `Model: <model> (<effort>) · <reason>` before Start. A brief with
no model shows the default.

Code decides the launch model:

1. The pack project's `model`, when set. It must be on the worker's list.
2. The brief's `model`, when it is on the list. An off-list model falls back to the default and
   the job records why.
3. The list default.

Before launch, Sym checks the choice against `orchestrator_capabilities`. An unavailable model
falls back to the first available listed model, the default first, and the job says so. With no
available listed model, Sym launches without a model selection and T3 uses the project default.

Effort goes with the model as `modelSelection.options: [{ id, value }]`. Sym picks the model's
select option whose ID is `effort`, `reasoningEffort`, `reasoning_effort`, or `reasoning` and that
offers the wanted value. A model without such an option launches without effort.

The job row keeps the launched model in `worker_model`. A scheduled run stores the model in its
approved brief, so the pre-approval comparison pins it (decision 024).

## Consequences

The brain can never name a model off the list: code replaces it. A stronger model costs more, so
the instruction asks for a stated reason. The `options` shape follows the `inheritedOptions` that
T3 reports and has not run against a live T3 yet. A pack that wants a different list must keep
its provider instance IDs in step with the worker's `pnpm t3:check` output.
