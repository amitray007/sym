# 016. Ledger migrations live in code

Status: accepted
Date: 2026-10-19

## Context

The ledger needs versioned schema changes. The Eve build bundles the agent, so SQL files read from
disk at runtime need extra path handling. Sym has one replica, but a deploy can overlap a manual
run.

## Decision

`lib/ledger/migrations.ts` holds an ordered list of migrations as SQL strings. `migrate()` takes a
Postgres advisory lock, records each version in `schema_migrations`, and applies pending ones in
one transaction. `pnpm db:migrate` runs it, before `eve start` in a deploy. A shipped migration
never changes. A fix is a new migration. Database checks back up code rules: the outbox refuses a
row without a display choice of level 1 to 4, and each check is wrapped in `coalesce(..., false)`
because a CHECK passes on NULL.

## Consequences

No migration tool dependency, and the SQL bundles with the agent. Tests migrate a fresh schema per
test file, so the files run in parallel against one database.
