# 033. Approved playbook rows load as instructions at session start

Status: accepted
Date: 2026-10-20

## Context

Learning layer 2 changes behavior through text the owner approves, without a redeploy
(decision 007). Rows must load only after approval and must not outrank the base rules.

## Decision

The `playbooks` table (migration 006) keeps every version of a playbook or rule with its status,
source, and evidence; one version per name is approved at a time. The owner proposes with
`playbook_propose` and approves with `playbook_review`, whose approval prompt shows the exact
body that will load. The weekly `learn` schedule turns a feedback pattern seen 3 times into one
proposal built from Sym's own template, never from the feedback text. `agent/instructions/playbooks.ts`
uses `defineDynamic` on `session.started` to add approved rows as system instructions, at most
8000 characters, inside a frame that says they are reviewed guidance and cannot lift an approval
or allow a write to production data.

## Consequences

A new rule takes effect on the next session with no build. A rejected pattern is not proposed
again for 28 days. Nothing records `fix` feedback yet, so that grouping waits for a source.
