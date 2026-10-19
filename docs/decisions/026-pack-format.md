# 026. The pack manifest is validated YAML without secrets

Status: accepted
Date: 2026-10-20

## Context

Adopter specifics live in a pack (decision 010). A wrong pack must fail early and clearly, and a
pack must never carry a secret.

## Decision

`lib/pack/load.ts` reads `sym.config.yaml` from `SYM_PACK_DIR` with the `yaml` package and checks
it against a strict Zod schema (`lib/pack/schema.ts`). Unknown fields fail. Any field named like a
secret (token, key, password, secret, credential) fails before the schema runs. Instruction and
playbook files are referenced by path and must stay inside the pack folder. Errors name the file
and the field. `lib/pack/policy.ts` maps a brief's project to the pack's allowed projects, adds
the pack's path and PR rules to the worker brief, and answers the Slack allow-list.

## Consequences

A pack can narrow Sym's rules but never widen them: `productionData` accepts only `read-only`, and
PRs are drafts at most. Sym adds one runtime dependency, `yaml`.
