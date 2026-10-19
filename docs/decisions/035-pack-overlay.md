# 035. The pack overlay copies instructions and playbooks before the build

Status: accepted
Date: 2026-10-20

## Context

A pack's instruction files and playbooks must reach the agent like built-in files (decision 010),
and milestone 1 asked whether Eve compiles them from an overlay.

## Decision

`scripts/pack-overlay.ts` validates the pack, then copies instructions to
`agent/instructions/<name>.md` and playbooks to `agent/skills/<name>.md` before `eve build`. It
never overwrites `agent/instructions.md` or another instruction file. A playbook named like a
built-in skill replaces it. The Dockerfile applies the overlay from an optional `pack` build
context. Eve 0.81.0 compiles both, checked with `eve build` and `docker build`.

## Consequences

Pack text changes need a rebuild; learned rows (decision 033) do not. The runtime still reads
`sym.config.yaml` from `SYM_PACK_DIR`, so a deployment mounts the pack there as well.
