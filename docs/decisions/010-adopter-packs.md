# 010. Adopter specifics live in packs

Status: accepted
Date: 2026-10-19

## Context

Each adopter has its own channels, repositories, playbooks, schedules, and rules. These must not enter the generic repository.

## Decision

An adopter keeps a private pack: `sym.config.yaml`, `instructions/`, `playbooks/`, `schedules.yaml`, and `evals/`. Instructions and playbooks overlay the agent folder at build time. The config loads at start from `SYM_PACK_DIR`. Approved layer-2 rows load per session.

## Consequences

One Sym release serves every adopter. Milestone 1 confirms that the build-time overlay compiles. See `docs/adopting.md`.
