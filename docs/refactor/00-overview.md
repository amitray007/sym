# Overview — Sym Refactor & OSS-Readiness Audit

**Date:** 2026-06-02 (corrective pass applied 2026-06-02)
**Audience:** the maintainer who will execute (or sponsor) this refactor.
**Read this first.** It is the map. The territory is in [`zones/`](./zones/) and
[`research/`](./research/); the route is in [`BACKLOG.md`](./BACKLOG.md).

> **This document was corrected on 2026-06-02** after a completeness critique
> ([`CRITIQUE.md`](./CRITIQUE.md)) and three gap-fill reviews. The headline numbers
> are now **288 findings across 17 zones, in 37 chunks**. The single biggest
> substantive change: the **TUI + operator CLI + encrypted SQLite credential
> store is intended, first-class architecture** — not slop to delete. See §3 and
> [`CRITIQUE-RESOLUTION.md`](./CRITIQUE-RESOLUTION.md).

---

## 1. Why this audit exists

Sym is about to be open-sourced. The bar for that is not "it works" — it already
works. The bar is that a newcomer can read it, understand it, and contribute,
and that it reads like an **exemplary hand-crafted OSS project** rather than
accumulated machine-generated sprawl.

The project went through a deliberate architectural collapse on 2026-05-27: from
a multi-service, Postgres-backed, **web-dashboard-driven** system down to a single
env-configured Slack teammate (`apps/agent`). The collapse was the right call.
But it was a subtraction, and subtractions leave residue: dead config that
references deleted features, docs that describe the old shape, half-removed
subsystems, and files that grew large under AI-assisted development and never got
re-sectioned. This audit finds that residue and turns it into a fix list.

What the collapse did **not** remove — and what this corrective pass makes
explicit — is Sym's **local-state control tier**: an operator TUI + CLI and an
encrypted local credential store. That tier was rebuilt deliberately to drive the
MCP-connector story, and it is intended architecture. The audit's job for it is to
**legitimize, clean, and document** it, not to delete it (§3, §4).

---

## 2. Current state of the codebase

**Inventory (ground truth, re-verified against `HEAD` 2026-06-02):** pnpm + Turbo
monorepo, Node ≥24, ESM. **~28k lines including tests; ~15.7k non-test source**
(`apps/agent/src` = 13,530; the three packages' `src` ≈ 2,170). **48 test files**
(47 `*.test.ts`/`*.test.tsx` + 1 `contracts.test-d.ts`). One app (`apps/agent`,
13,530 lines) and three packages (`contracts`, `kernel`, `adapter/slack`).

> **Counts corrected from the first draft:** the earlier "~28,200 _source_ lines"
> conflated source with tests (the 113 `.ts` + 12 `.tsx` figure _includes_ test
> files); the real non-test source is ~15.7k. "53 test files" was wrong — there
> are **48**. Env vars: **≥15 read in code / 9 documented in the README** (the
> earlier "18+" was presented as counted but was not).

**What is genuinely good (do not "fix"):**

- The monorepo skeleton is well-formed: a clean three-tier convention
  (`apps/*` → runtime, `packages/*` → shared libs, `packages/adapter/*` →
  platform adapters) with an **acyclic, correctly-layered** dependency graph
  (`contracts` ← `kernel`/`adapter-slack` ← `agent`). _(Verified: no runtime
  cross-package import violations; only doc-comments cross the boundary.)_
- The ESM + NodeNext + `verbatimModuleSyntax` setup is current gold-standard
  (R1). `composite: false` correctly defers build ordering to Turbo.
- The runtime story is coherent: signed Slack event → verify → owner gate →
  fetch thread as context → Pi agent loop → streamed reply. The "thread is the
  conversational memory" model is real and consistently implemented.
- Commit discipline (Husky + lint-staged + commitlint + Conventional Commits)
  and the per-package `tests/` convention are in place.

**What has drifted — the core tension:** parts of the codebase no longer match
its own stated framing. The drift shows up in four shapes, detailed next.

---

## 3. The core tension: drift, and a North Star that needs restating

The README's first paragraph says: _"No database, no dashboard — configured
entirely by environment variables."_ That sentence is **too strong as written**,
and the correction is a deliberate architectural statement, not a concession:

> **North Star (restated).** The Slack **thread** is Sym's **conversational
> memory** — there is no message database, and that is what "stateless" means.
> Sym **also** has an intentional **local-state control tier**: an operator TUI +
> CLI (`sym` command, incl. the `SecretsManager` screen and config/admin/secrets
> verbs) and an **encrypted local SQLite credential store**
> (`apps/agent/.sym/credentials.db`) holding MCP OAuth tokens. "Stateless"
> describes the conversational tier only — never the operator tooling or
> credential storage.

Four bodies of evidence bear on this. The first is now **reframed**; the other
three are pure code-quality issues, **unaffected** by the reframe.

### (a) The local-state control tier vs. an over-strong "no dashboard" claim — REFRAMED

`apps/agent/src/tui/` (10 files) ships a full Ink/React terminal dashboard
including a `SecretsManager` screen, and `apps/agent/src/cli/` (4 files) ships the
`sym` operator verbs backed by the encrypted SQLite credential store
(`SYM_ENCRYPTION_KEY`). The old README "no dashboard" line and the FUTURE.md
"collapse removed Secrets/Dashboard" line contradict that code.

**The resolution (owner decision 2026-06-02) is to KEEP all of it and fix the
docs**, not to delete the tier. This is intended architecture: the MCP-connector
flow is Sym's primary extension point and genuinely benefits from an operator
TUI/CLI and an encrypted token store. The work is to **legitimize** it — make it
coherent, well-structured, and documented as a first-class _control tier_
distinct from the stateless _conversational tier_ — and to re-frame one sentence
of README ("no _web_ dashboard; ships an operator TUI/CLI + encrypted credential
store as a deliberate control tier"). The `SecretsManager` screen is **kept**.
_(Backlog **C03**, recast from "decide keep-or-kill" to "legitimize + document";
on the critical path. Confirmed: Z09-01, Z09-08, Z13-01, Z08-03, Z14-06, Z14-12 —
all recast from "delete because stateless" to "legitimize the control tier.")_

### (b) Two Slack clients across a package boundary — STANDS

`apps/agent/src/slack-client.ts` (570 lines) contains `WebApiSlackClient`, the
concrete HTTP implementation — but it lives in the **app**, while the
`SlackClient` interface, the retry layer, and all the param/result types it
implements live in **`packages/adapter/slack`**. The impl reaches back across the
boundary and re-declares a local `SlackWebApiError`. The adapter package is
therefore incomplete: a second app could not reuse it without re-implementing the
client. _Confirmed: Z05-01, Z05-03, Z12 (boundary side). → C12._

### (c) Five oversized files (one at 1679 lines) — STANDS

| File                | Lines | Problem                                                                                                    |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `builtin-tools.ts`  | 1679  | 866-line `dispatch` if/else over 17 tools; 26× error-boilerplate; 11× err-extraction; 18× cast boilerplate |
| `handle-turn.ts`    | 1057  | four unrelated concerns (TaskCardManager, streaming, context-loading, orchestration) in one file           |
| `server.ts`         | 804   | five nested closures; signature verification copy-pasted three times                                       |
| `pi/loop.ts`        | 734   | one ~350-line `runLoopPi` mixing 7 concerns; 98-line `beforeToolCall` closure                              |
| `mcp/dispatcher.ts` | 652   | pool + dispatcher + reconcile + introspection + test helpers in one file                                   |

These are the primary readability blockers for a newcomer. None are buggy; all
are dense. _Confirmed: Z06-01, Z04-01, Z04-02/03, Z07-01, Z08-10. → C13–C16._

### (d) Documentation describes a repo that no longer exists — STANDS (with corrections)

The README "Repository layout" lists only `apps/agent` + `docs/`; the actual tree
has three packages plus `slack/`, `dokploy/`, `scripts/`, `assets/`. The env-var
table documents 9 variables; the agent reads ≥15. **The wrong Slack scopes are in
`README.md:45` ONLY** (`im:write` instead of `im:read`; missing `commands` and
`assistant:write`) — `slack/manifest.template.yml` is **already correct**
(`im:read`, `commands`, `assistant:write`, `assistant_thread_*` at lines
64/88/90/124-125). A newcomer following the README prose cannot stand up a working
bot; the fix is to point the README at `pnpm manifest:render` as the single
source of truth. Three setup scripts (`dev-setup.sh`, `setup-macos.sh`,
`setup-linux.sh`) install Postgres + Redis and run a missing `pnpm db:migrate`.
_Confirmed: Z01-01, Z03-01 (critical), Z03-02 (critical), Z14-01..05, env cluster.
→ C20, C01._

---

## 4. Top cross-cutting risks (ranked)

These recur across the most zones and most endanger the OSS launch. Each maps to a
backlog chunk. The first eleven are the structural/quality risks; the security,
logging, performance and supply-chain rows below them are the cross-cutting
concerns the gap-fill pass now **owns** (they had no owner in the first draft —
critique M1–M5).

| #   | Risk                                                                                                                                                                                                                                                                                       | Severity | Zones                        | Backlog       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------- | ------------- |
| 1   | **Dead setup scripts** install Postgres/Redis and run a missing `db:migrate` — first contributor following the docs hits a hard failure                                                                                                                                                    | critical | Z02, Z03, Z14                | C01           |
| 2   | **The local-state control tier was undocumented and contradicted by stale "no dashboard" copy** — now resolved by legitimizing + documenting it as an intended tier (NOT deleting), on the critical path                                                                                   | high     | Z09, Z13, Z08, Z14           | **C03**       |
| 3   | **README cannot stand up a working bot**: wrong Slack scopes in `README.md:45`, missing `commands`/`assistant:write`, no `manifest:render` pointer (manifest template is already correct)                                                                                                  | high     | Z03, Z14                     | C20           |
| 4   | **≥6 env vars undocumented** in `.env.example` and the README table (`SYM_ENCRYPTION_KEY`, `SYM_PUBLIC_URL`, `SYM_DB_PATH`, `SYM_MCP_SERVERS`, `SYM_CLI_ALLOWLIST`, …) — deployers enabling connectors hit cryptic errors                                                                  | high     | Z03, Z04, Z07, Z08, Z09, Z14 | C02           |
| 5   | **Two Slack clients** across the package boundary — the adapter package is incomplete and unreusable                                                                                                                                                                                       | high     | Z05, Z12                     | C12           |
| 6   | **`builtin-tools.ts` (1679 lines)** with an 866-line dispatch chain is the single largest readability blocker; `run_cli`/`set_plan`/`update_task` (the most security-sensitive tools) have zero dispatch tests                                                                             | high     | Z06, Z13                     | C13, C09      |
| 7   | **`no-explicit-any: warn` with no `--max-warnings 0`** — the type-safety guard is illusory; `any` casts pass CI and pre-commit silently                                                                                                                                                    | high     | Z02                          | C05           |
| 8   | **No import-boundary / dead-code enforcement** (no knip, no dependency-cruiser) — package isolation and the DAG are convention-only and will erode invisibly                                                                                                                               | high     | Z02, R1, R3                  | C07           |
| 9   | **Stale `dist/` artefacts** from deleted features ship inside three packages — a reader of the built package sees dead public API for types that no longer exist in source                                                                                                                 | high     | Z10, Z11, Z12                | C04           |
| 10  | **`response_url` / MCP HTTP transport URLs forwarded to `fetch()` without domain/SSRF validation** — defense-in-depth gaps in an about-to-be-public codebase                                                                                                                               | medium   | Z04, Z08, Z05                | C11           |
| 11  | **`POST /slack/interactivity` — the owner-gated destructive-tool authorization chain — has ZERO adversarial test coverage** (forged/replayed/non-owner/post-timeout clicks all unexercised); `confirmations.ts`/`slack-guard.ts`/`assistant.ts` were entirely unreviewed in the first pass | high     | Z15                          | C26, C27, C28 |
| 12  | **Credential DB created world-readable** (`mkdirSync`/no `chmod`); connector names are plaintext columns — AES-256-GCM on the values is mitigating but not a substitute                                                                                                                    | medium   | Z15                          | C27           |
| 13  | **No CI gate on `console.log` + no per-turn correlation id** — the documented flaky-CI regression (server `console.log` racing into the CLI `--json` parse) is one careless line away from recurring; concurrent turns produce indistinguishable logs                                      | medium   | Z16                          | C35           |
| 14  | **No per-turn abort deadline + unbounded thread context** to the LLM — a stuck model loops without a credit ceiling, and a 200-reply thread is re-sent in full every turn                                                                                                                  | medium   | Z16                          | C36           |
| 15  | **No dependabot for the npm ecosystem** (Actions only) + no third-party license attribution — runtime-dep advisories (`ink`, `hono`, MCP SDK) go undetected                                                                                                                                | low      | Z16                          | C21           |
| 16  | **Dead/incorrect MCP internals** — a phantom `listAsync` warm-up method, an `ensureEntry` client leak, and a `NaN` connect-timeout that silently disables the 10 s guard                                                                                                                   | high/med | Z08-supp                     | C31           |

Two more that are launch-blockers by their absence rather than their presence:

- **Missing OSS baseline files** (`CONTRIBUTING`, `SECURITY`, `ARCHITECTURE`,
  `CHANGELOG`, `CODE_OF_CONDUCT`, issue templates) — GitHub's community-health
  floor is unmet.
  _Z02-18, Z14-08/09/22/23/24/25._ → C21, C22.
- **No code-coverage instrumentation anywhere** — all the test gaps are unmeasured
  and invisible. _Z13-02 (critical)._ → C08.

---

## 5. Methodology

The audit was deliberately structured to be **disjoint and parallel**, mirroring
how the refactor itself will be executed.

- **17 zones** (14 original + the three corrective-pass zones), each owning a
  non-overlapping slice of the repo. A reviewer per zone produced a structured
  report: summary, findings table, per-finding file:line evidence + a specific
  recommendation + severity + effort + blast radius, top risks, and
  locally-proposed chunks. The full ownership partition is in [`ZONES.md`](./ZONES.md).
  - The original 14 (Z01–Z14) covered config, build, each oversized file or
    subsystem, each package, tests, and docs.
  - **Z15 (End-to-End Security & Trust-Boundary)** closed the gap that
    `confirmations.ts`, `slack-guard.ts`, and `assistant.ts` — 393 lines of
    security-sensitive source — had **no owner** in the first pass (critique G1).
  - **Z16 (System-level Cross-Cutting Concerns)** closed logging/observability,
    hot-path performance, supply-chain, and TUI accessibility — whole-system
    properties the per-file partition structurally missed (critique M2–M5).
  - **Z08-supplement** re-reviewed the MCP files the first Z08 named only in
    passing (`composite.ts`, `materialize.ts`, `providers/static.ts`, …) and added
    10 findings (critique G2).
- **3 research streams** established the external best-practice bar: monorepo
  packaging (R1), OSS docs & community health (R2), and code-quality / anti-slop
  tactics (R3).
- **Synthesis** (this document set): the **288 findings** were de-duplicated into
  **37 dependency-ordered chunks**. The rule was _preserve every real finding, but
  express the work as the tightest possible chunk list_ — a cross-cutting issue
  that appeared in four zones becomes one chunk citing all four finding IDs.

**Severity rubric** (used consistently across zones): `critical` = broken /
unsafe / blocks OSS launch; `high` = significant structural problem; `medium` =
should fix; `low` = nice-to-have polish.

**Finding distribution:** **288 total** — 255 from the original 14 zones (the
true count; the earlier "252" miscounted Z05 at 15 instead of 17 and Z12 at 13
instead of 14) plus 33 from the gap-fill (Z15 = 10, Z16 = 13, Z08-supplement =
10). The critical + high findings are where launch risk concentrates and where the
backlog front-loads effort. **Coverage is now complete:** every one of the 288
findings maps to exactly one chunk, and there are no unowned live source files
(`confirmations.ts`/`slack-guard.ts`/`assistant.ts` are now covered by Z15).

---

## 6. Shape of the fix (what the backlog does)

The backlog is ordered as **quick wins → instrument → structural → harden →
docs/OSS-readiness**, so the riskiest mechanical changes land after the codebase
is already cleaner and better-instrumented:

1. **Purge & document & legitimize** (C01–C07): delete dead scripts/config/`dist`
   artefacts, document every env var, **legitimize + document the local-state
   control tier (C03)**, fix dependency classification, tighten lint to actually
   fail on `any`, and add knip/dependency-cruiser (committing the generated DAG).
2. **Instrument** (C08–C09): coverage + the missing dispatch/route/package tests,
   so the structural work that follows is guarded.
3. **Structure** (C10–C19): the dead-code sweep, the single-Slack-client
   consolidation, the `builtin-tools.ts` split, the decomposition of the other
   oversized files, the contracts type moves, and the per-module polish.
4. **Harden the cross-cutting concerns** (C26–C37): adversarial interactivity
   tests, credential-store hardening, guard observability, the MCP-supplement
   fixes, the logging gate + correlation id, hot-path performance bounds, and TUI
   accessibility.
5. **OSS-readiness** (C20–C25): README overhaul, community-health + supply-chain
   files, ARCHITECTURE.md (with the two-tier model + perf budget), CHANGELOG,
   examples/, and the final quality-gate promotion.

Every chunk is sized so the build stays green and the app keeps working at each
commit. Contract-touching chunks (C12, C17, C18) carry an explicit instruction to
run the [`cross-unit-impact`](../../.claude/skills/cross-unit-impact/SKILL.md)
checklist first.

Proceed to [`TARGET-STRUCTURE.md`](./TARGET-STRUCTURE.md) for the end-state, then
[`BACKLOG.md`](./BACKLOG.md) for the route.
