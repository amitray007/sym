# 025. Memory lives in Postgres, per person

Status: accepted
Date: 2026-10-20

## Context

Learning layer 1 needs durable facts and preferences (decision 007). Eve's `fileMemory` needs
Vercel Blob off Vercel. Self-hosted Sym already has Postgres.

## Decision

`lib/memory/provider.ts` implements Eve's custom memory provider on the `memory_facts` table
(migration 004). The `owner` slot (`agent/memory/owner.ts`) uses `byPrincipal`, so each Slack
person has their own facts. Recall loads the newest 40 facts each turn as notes, not instructions.
The model saves, updates, searches, and forgets facts with the slot's tools. Saving the same text
twice in a scope keeps one row, so a replayed tool call adds nothing.

## Consequences

Schedule turns run as the app principal and get no memory. Search is plain Postgres full-text
search; no vector extension is needed. Facts are rows, so the owner can read and delete them.
