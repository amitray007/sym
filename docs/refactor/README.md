# Sym Refactor & OSS-Readiness Audit

This folder is the recorded output of a full structural audit of the Sym
codebase, run on 2026-06-02 in preparation for open-sourcing the project. It is
both a **diagnosis** (what is wrong, with file:line evidence) and a **program**
(an ordered backlog of refactor chunks that fixes it while keeping the build
green at every step).

The audit was run as **disjoint zone reviews + 3 research streams**, then
consolidated by a lead synthesizer into the five top-level documents below. The
zone and research reports are the raw evidence; the top-level docs are the
decisions.

> **Corrective pass (2026-06-02).** A completeness critique
> ([`CRITIQUE.md`](./CRITIQUE.md)) found coverage holes and count errors; three
> gap-fill reviews (Z15 security, Z16 cross-cutting, Z08-supplement) closed them.
> The headline numbers below are the **reconciled** figures: **288 findings, 17
> zones, 37 chunks.** The biggest substantive change: the operator TUI/CLI +
> encrypted SQLite credential store is now documented as **intended local-state
> architecture** (kept, not deleted). The full critique-item ledger is in
> [`CRITIQUE-RESOLUTION.md`](./CRITIQUE-RESOLUTION.md).

## Headline numbers

| Metric                        | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| Zones reviewed                | 17 (14 original + Z15 security, Z16 cross-cutting, Z08-supplement) |
| Research streams              | 3                                                                  |
| Files reviewed (across zones) | ~150                                                               |
| **Total findings**            | **288**                                                            |
| — critical                    | 4                                                                  |
| — high                        | 55                                                                 |
| — medium                      | 96                                                                 |
| — low                         | 133                                                                |
| Consolidated refactor chunks  | 37                                                                 |

The 288 per-zone findings de-duplicate down to **37 dependency-ordered chunks**
in [`BACKLOG.md`](./BACKLOG.md). The same real issue (e.g. "two Slack clients",
"dead setup scripts", "undocumented env vars") often surfaced in three or four
zones; the backlog collapses each into a single chunk that cites every
contributing finding ID. The split is: **255** findings from the original 14
zones (the true count — the first draft's "252" miscounted Z05 and Z12) plus
**33** from the gap-fill (Z15 = 10, Z16 = 13, Z08-supplement = 10).

## How this folder is organized

```
docs/refactor/
  README.md                ← you are here: the index
  00-overview.md           ← executive summary; read this first
  TARGET-STRUCTURE.md      ← the end-state repo layout (before → after)
  ZONES.md                 ← the 17-zone map + disjoint-ownership partition
  BACKLOG.md               ← THE deliverable: 37 ordered refactor chunks
  CRITIQUE.md              ← the completeness critique that drove the corrective pass
  CRITIQUE-RESOLUTION.md   ← how each critique item (G/M/U/D series) was resolved
  zones/                   ← the 17 raw per-zone evidence reports (Z01–Z16 + Z08-supplement)
  research/                ← the 3 external best-practice research reports (R1–R3)
```

## How to use it

- **New maintainer, never seen this audit?** Read [`00-overview.md`](./00-overview.md)
  first (the state of the codebase + top risks), then [`TARGET-STRUCTURE.md`](./TARGET-STRUCTURE.md)
  (where we are going), then skim [`BACKLOG.md`](./BACKLOG.md) (how we get there).
- **About to do the work?** [`BACKLOG.md`](./BACKLOG.md) is the execution plan.
  Start at the top (quick wins), respect the `dependsOn` ordering, and each
  chunk leaves the build green. Chunks flagged "cross-unit" must run the
  [`cross-unit-impact`](../../.claude/skills/cross-unit-impact/SKILL.md) checklist first.
- **Parallelizing the refactor?** [`ZONES.md`](./ZONES.md) is the disjoint
  file-ownership partition — it tells you which zones can be worked in parallel
  without touching each other's files.
- **Need the evidence behind a recommendation?** Every chunk in the backlog
  cites finding IDs (e.g. `Z06-01`). Open the matching `zones/Z06-*.md` report
  for the full file:line evidence and the original reviewer's reasoning.

## Zone reports (raw evidence)

Each zone owns a disjoint slice of the repo. The report contains a summary, a
findings table, per-finding evidence + recommendations, top risks, and the
zone's locally-proposed chunks (later merged into the global backlog).

| Zone      | Title                                           | Findings | Report                                                         |
| --------- | ----------------------------------------------- | -------- | -------------------------------------------------------------- |
| Z01       | Repo structure & monorepo packaging             | 15       | [Z01-repo-structure.md](./zones/Z01-repo-structure.md)         |
| Z02       | Tooling: lint, format, hooks, CI                | 20       | [Z02-tooling-ci.md](./zones/Z02-tooling-ci.md)                 |
| Z03       | Build, deploy & runtime infra                   | 19       | [Z03-build-deploy.md](./zones/Z03-build-deploy.md)             |
| Z04       | Core agent — entry & orchestration              | 17       | [Z04-core-orchestration.md](./zones/Z04-core-orchestration.md) |
| Z05       | Slack I/O & text processing (app layer)         | 17       | [Z05-slack-io-text.md](./zones/Z05-slack-io-text.md)           |
| Z06       | builtin-tools.ts (the 1679-line monolith)       | 17       | [Z06-builtin-tools.md](./zones/Z06-builtin-tools.md)           |
| Z07       | Pi agent loop                                   | 17       | [Z07-pi-loop.md](./zones/Z07-pi-loop.md)                       |
| Z08       | MCP client subsystem                            | 20       | [Z08-mcp-client.md](./zones/Z08-mcp-client.md)                 |
| Z09       | TUI & CLI (local-state control tier)            | 20       | [Z09-tui-cli.md](./zones/Z09-tui-cli.md)                       |
| Z10       | packages/contracts (shared types)               | 11       | [Z10-contracts.md](./zones/Z10-contracts.md)                   |
| Z11       | packages/kernel                                 | 13       | [Z11-kernel.md](./zones/Z11-kernel.md)                         |
| Z12       | packages/adapter/slack                          | 14       | [Z12-adapter-slack.md](./zones/Z12-adapter-slack.md)           |
| Z13       | Tests & QA strategy                             | 21       | [Z13-tests-qa.md](./zones/Z13-tests-qa.md)                     |
| Z14       | Documentation & OSS readiness                   | 34       | [Z14-docs-oss.md](./zones/Z14-docs-oss.md)                     |
| **Z15**   | **End-to-end security & trust-boundary review** | **10**   | [Z15-security.md](./zones/Z15-security.md)                     |
| **Z16**   | **System-level cross-cutting concerns**         | **13**   | [Z16-cross-cutting.md](./zones/Z16-cross-cutting.md)           |
| **Z08-s** | **MCP subsystem (supplement)**                  | **10**   | [Z08-supplement.md](./zones/Z08-supplement.md)                 |

## Research reports (external best practice)

Three research streams establish the OSS-quality bar against which the codebase
was measured. The backlog's recommendations cite these.

| ID  | Topic                                          | Report                                                          |
| --- | ---------------------------------------------- | --------------------------------------------------------------- |
| R1  | TypeScript monorepo structure & packaging      | [R1-monorepo-packaging.md](./research/R1-monorepo-packaging.md) |
| R2  | OSS documentation & community-health           | [R2-docs-community.md](./research/R2-docs-community.md)         |
| R3  | TypeScript code-quality & anti-AI-slop tactics | [R3-code-quality.md](./research/R3-code-quality.md)             |

## The one-paragraph takeaway

The monorepo skeleton is sound and the runtime architecture is coherent. The work
is twofold. First, **legitimize what's intended**: Sym's operator TUI/CLI +
encrypted SQLite credential store is a deliberate **local-state control tier**
that the old README wrongly disclaimed — the fix is to document it as first-class
architecture (the _conversational_ tier is stateless; the _control_ tier is not),
not to delete it. Second, **clean the genuine drift**: two Slack clients split
across a package boundary, five files over 500 lines (one at 1679), stale `dist/`
artefacts and dead config, and documentation that describes a repo that no longer
exists — plus the cross-cutting concerns the first pass missed (the
`POST /slack/interactivity` trust boundary, logging/observability, hot-path cost,
supply-chain, TUI accessibility). None of this is broken — it is **drift and
under-documentation** — and all of it is fixable with the 37 chunks in the
backlog without rewriting the core.
