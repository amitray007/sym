# 015. Worker adapters call the worker from code

Status: accepted
Date: 2026-10-19

## Context

Eve MCP connections (`agent/connections/*.ts`) are model-facing. The model finds their tools with
`eve__search` and calls them with `eve__tool`. Eve has no API that lets tool or schedule code call
a connection's tools. The watch loop and reconcile run as code without a model turn. Eve's
self-hosted interactive OAuth is always user-scoped, so a schedule session without a user fails
with `principal_required`.

## Decision

The T3 adapter (`lib/workers/t3/`) holds its own MCP client, `@modelcontextprotocol/client`,
pinned exactly. The adapter takes a `CallTool` function, so tests pass a fake and never reach a
real worker. The client gets its bearer token from a `getToken` function. Milestone 1 uses a
manual token from the environment. Later, Sym stores the OAuth token in Postgres after the owner
approves the sign-in, and `getToken` reads it there. T3 is not an Eve connection, so the model
cannot launch a worker thread around the ledger.

## Consequences

Every worker call goes through the adapter contract in `lib/workers/types.ts`. Sym owns the OAuth
client flow for T3 instead of using `defineInteractiveAuthorization`. That answers the open check
in `docs/milestone-1.md`: Eve's interactive flow works only for user-scoped sessions, which
reconcile and schedules are not.
