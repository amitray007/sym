# 009. Default T3 access level is Auto

Status: accepted
Date: 2026-10-19

## Context

T3 access levels cap every thread an outside client starts. Permission prompts cannot be approved over MCP, so a lower level blocks more jobs. Full access widens what a leaked token can do.

## Decision

The documented default is Auto. Adopters may choose Full access for unattended jobs that must never block.

## Consequences

Some jobs still block on permission prompts. Sym detects `waiting` with no pending question and DMs the owner to approve on the worker.
