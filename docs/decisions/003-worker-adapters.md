# 003. Workers behind adapters, T3 Code first

Status: accepted
Date: 2026-10-19

## Context

Real work runs best in a full coding agent on the adopter's own machine and subscriptions. T3 Code exposes Claude Code and Codex threads through a remote MCP endpoint. Other workers may follow.

## Decision

Sym never edits repositories itself. It drives workers through an adapter contract (`docs/workers.md`). The first adapter targets T3 Code over its remote MCP endpoint and OAuth.

## Consequences

The ledger, watch loop, and display rule do not depend on T3. T3's limits (no push events, no permission approval over MCP, 30-day sign-ins) are handled inside the adapter and reconcile.
