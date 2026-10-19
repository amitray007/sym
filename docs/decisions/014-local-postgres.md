# 014. Local Postgres and the database client

Status: accepted
Date: 2026-10-19

## Context

The ledger needs Postgres in local work, in CI, and in deployment. Sym also needs a Node client
and a way to test ledger code. Many developer machines already run a Postgres on port 5432.

## Decision

`compose.yaml` runs Postgres 18 for local work, bound to `127.0.0.1:55432`. `pnpm db:up` starts
it and waits for its health check. `pnpm db:down` stops it. The client is postgres.js (npm
`postgres`, pinned exactly). `lib/db.ts` validates `DATABASE_URL` with Zod and never echoes its
value. Ledger tests run against a real Postgres: CI starts a Postgres 18 service, and local runs
need `pnpm db:up` and `DATABASE_URL`. Tests still fake the worker, Slack, and the model.

## Consequences

Ledger tests check real SQL, constraints, and transactions instead of a fake. They skip when
`DATABASE_URL` is unset, so CI is the gate that always runs them. The client has no runtime
dependencies, and SQL stays in tagged templates instead of a query builder.
