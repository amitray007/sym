# Critique Resolution — how every critique item was closed

**Date:** 2026-06-02
**Inputs:** [`CRITIQUE.md`](./CRITIQUE.md) (the completeness critic's report) +
three gap-fill reviews (Z15 security, Z16 cross-cutting, Z08-supplement) +
maintainer ground-truth re-verification against `HEAD`.

This document is the **ledger**: it maps every item the critic raised — gaps
(G1–G5), missing coverage (M1–M6), inaccurate claims (U1–U5), and
dependency-ordering defects (D1–D3) — to exactly how the corrective pass resolved
it. Each row is **closed**, **corrected**, **reframed**, or **rejected** (the
critic's own false positives).

After this pass the program stands at **288 findings across 17 zones, mapped to 37
chunks**, with complete coverage (no unowned live source files) and the headline
numbers identical across [`README.md`](./README.md), [`00-overview.md`](./00-overview.md),
[`ZONES.md`](./ZONES.md), and [`BACKLOG.md`](./BACKLOG.md).

---

## Gaps — guarantees that didn't hold (G-series)

| Item   | Critic's finding                                                                                                               | Resolution                                                                                                                                                                                                                                                                                                                                                         | Where                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **G1** | 3 live source files (`confirmations.ts`, `slack-guard.ts`, `assistant.ts`, 393 LOC, 2 security-sensitive) owned by **no** zone | **Closed.** New **Z15** does a dedicated line-by-line security pass over all three; 10 findings (Z15-01..10). The interactivity→confirmation→destructive-tool chain is the centerpiece.                                                                                                                                                                            | Z15-security.md; ZONES.md (Z15 row + "what they close"); backlog C26–C30 |
| **G2** | Z08 named only ~4 of ~13 MCP files; `composite.ts`/`materialize.ts`/`providers/static.ts` unexamined                           | **Closed.** New **Z08-supplement** reviews the unnamed files; 10 findings (Z08-21..30).                                                                                                                                                                                                                                                                            | Z08-supplement.md; backlog C31–C34                                       |
| **G3** | Coverage guarantee false: zone IDs total **255** not 252; 3 findings (Z05-16, Z05-17, Z12-14) dropped                          | **Closed + corrected.** True original total restated as **255**; the 3 dropped findings assigned — **Z05-16 → C12**, **Z05-17 → C10**, **Z12-14 → C12**. Re-reconciled: all 288 findings now map to exactly one chunk (verified bidirectionally).                                                                                                                  | BACKLOG.md "Coverage guarantee"; 00-overview §5; ZONES.md                |
| **G4** | Z13 audited a stale tree: claimed 53 files, named 3 phantoms, omitted ~13 real files                                           | **Closed.** Z13 inventory **rewritten** to the real **48-file** tree: phantoms (`workspace-context.test.ts`, `registry.test.ts`, `retry.test.ts`) removed; the 13 omitted files added; C09 reconciled (`workspace-context.ts` genuinely has no test → "add one" is correct).                                                                                       | Z13-tests-qa.md (new "Test inventory" section + Z13-06 reconciliation)   |
| **G5** | The stateless-vs-stateful decision (C03) left unresolved — a 2× effort range gating C09/C10/C19                                | **Reframed + closed.** Owner decision: **keep the entire local-state control tier** (TUI/CLI/SecretsManager + SQLite store) as intended architecture. C03 recast from "decide keep-or-kill" to "**legitimize + document**." Effort firms to S–M (no Option-B deletion branch). The exact surviving file set is now named so C03 is executable from the docs alone. | TARGET-STRUCTURE §5; 00-overview §3; backlog C03                         |

---

## Missing coverage — cross-cutting concerns nobody owned (M-series)

| Item   | Critic's finding                                                                                                                            | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **M1** | No end-to-end security / trust-boundary review; the `POST /slack/interactivity` destructive-tool authorization chain unaudited and untested | **Closed.** Z15 reviews the four privileged entry points (`/slack/events`, `/slack/commands`, `/slack/interactivity`, `/admin/*`) as a trust boundary. **C26** adds six adversarial interactivity tests (forged/replayed/non-owner/foreign-workspace/invalid-`action_id`/post-timeout). SECURITY.md (C21) now lists the interactivity chain explicitly.                                                                                                                                                       | Z15; backlog C26, C27, C28, C29, C30; C21     |
| **M2** | No logging/observability strategy; (claimed) two server-path `console.log` violations; no correlation id / log-level convention             | **Closed — with a correction (see U-note below).** Z16 owns logging. **C35** adds a CI grep-gate forbidding `console.log` outside `cli/`, threads a per-turn `turn.id` correlation prefix, and codifies the error/warn/info convention (in ARCHITECTURE.md via C22). **The critic's "two `console.log` violations" are FALSE POSITIVES** (a comment + a help string) — there are **zero** executable `console.log` outside `cli/`. No "fix two console.log" task exists; only the gate + correlation-id work. | Z16-01/02/03; backlog C35; C22                |
| **M3** | Performance never analyzed as a system; no per-turn latency/cost budget, no thread-context bound                                            | **Closed.** Z16 owns hot-path performance. **C36** adds a 60 s Pi-loop abort deadline, a bounded `conversationsReplies` history limit (`SYM_THREAD_HISTORY_LIMIT`, default 80), and a per-turn latency/cost budget section in ARCHITECTURE.md that rolls the scattered micro-findings (Z03-10, Z07-10, Z08-08, Z06-14, Z05-15) under it.                                                                                                                                                                      | Z16-04/05/06/07; backlog C36; C22             |
| **M4** | TUI accessibility never raised (`NO_COLOR`, isTTY, color contrast, dumb terminals)                                                          | **Closed.** Z16 owns it. **C37** shims `NO_COLOR`→`FORCE_COLOR=0` (Chalk 5 doesn't honor `NO_COLOR`), adds the isTTY guard to `sym menu`/`sym tui`, and an optional ASCII glyph fallback. Now a real OSS-quality item since C03 **keeps** the TUI.                                                                                                                                                                                                                                                            | Z16-11/12/13; backlog C37                     |
| **M5** | No third-party license attribution / npm supply-chain posture (dependabot was Actions-only; no SBOM)                                        | **Closed.** **C21** extends `dependabot.yml` to the **npm** ecosystem (all workspaces) + Actions, adds `pnpm audit` to CI, generates `THIRD-PARTY-LICENSES.md` (all runtime deps confirmed MIT/ISC), and notes SBOM as deferred to the OSS-launch tag.                                                                                                                                                                                                                                                        | Z16-08/09/10; backlog C21                     |
| **M6** | The dependency DAG is asserted, not produced as an artifact                                                                                 | **Closed.** **C07** now **commits the generated dependency-cruiser graph** (`docs/reference/dependency-graph.*`), so "acyclic and correctly layered" stops being a manual assertion. (The critic independently verified the DAG _is_ clean today — only doc-comments cross the boundary.)                                                                                                                                                                                                                     | backlog C07; TARGET-STRUCTURE §6 "after" tree |

---

## Unverified / inaccurate claims (U-series)

| Item   | Critic's finding                                                                             | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                        | Where                                            |
| ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **U1** | "53 test files" — actual is 48                                                               | **Corrected** everywhere to **48** (47 `*.test.ts`/tsx + 1 `contracts.test-d.ts`). Re-verified: `find apps packages -path '*/tests/*' -name '*.test*'` = 48.                                                                                                                                                                                                                                                                                      | 00-overview §2; Z13 inventory                    |
| **U2** | "rendered `slack/manifest.yml` with a personal ngrok URL is committed" — it is **not**       | **Corrected.** `git ls-files slack/` returns only `README.md` + `manifest.template.yml`. Z03-07/C21 reframed from "git rm the committed manifest" to "add a CI/gitignore guard so a rendered manifest can **never** be committed (none is today)." The TARGET "before" tree no longer depicts a committed rendered manifest.                                                                                                                      | TARGET-STRUCTURE §6; backlog C21; 00-overview §3 |
| **U3** | "wrong Slack scopes" mislocated — the manifest **template** is correct; only README is wrong | **Corrected.** The wrong scopes (`im:write`, missing `commands`/`assistant:write`) are in **`README.md:45` only**. `slack/manifest.template.yml` is **already correct** (`im:read`, `commands`, `assistant:write`, `assistant_thread_*` at lines 64/88/90/124-125 — re-verified). C20 states this explicitly and fixes the README prose by pointing at `pnpm manifest:render` as the single source of truth, **not** by hand-editing scope lists. | 00-overview §3(d); backlog C20                   |
| **U4** | "~28,200 source lines" conflates source with tests                                           | **Corrected.** Relabelled "**~28k lines incl. tests; ~15.7k non-test source**" (`apps/agent/src` = 13,530; packages' `src` ≈ 2,170). The 113 `.ts` + 12 `.tsx` figure included test files.                                                                                                                                                                                                                                                        | 00-overview §2                                   |
| **U5** | "env table documents 9 / agent reads 18+" — "18+" presented as counted but isn't             | **Corrected.** Restated as "**≥15 read in code / 9 documented in the README**." (Direct `process.env` grep finds ~15–16 distinct names once the MCP/CLI knobs are counted; "18+" is dropped.)                                                                                                                                                                                                                                                     | 00-overview §2 + §4 row 4; backlog C02, C20      |

---

## Dependency-ordering defects (D-series)

| Item   | Critic's finding                                                                                                      | Resolution                                                                                                                                                                                                                                                                                                                                                                            | Where                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **D1** | C19 renames `thinking-copy.ts`, but **C15** populates it — and C19 didn't depend on C15                               | **Closed.** The edge **C19 → C15** is added: C15 moves `WHIMSY_WORDS`/`nextWhimsicalStatus` _into_ `thinking-copy.ts`; C19 renames it → `shimmer-phrases.ts` **after** it's populated. Both chunks' notes call this out.                                                                                                                                                              | backlog C15, C19, dependency graph           |
| **D2** | C03 is a decision gate with a 2× effort range that blocks the critical path but wasn't drawn on it                    | **Closed.** **C03 is now the lead node on the critical path** (`C03 → C04 → C07 → C10 → C16 → C20 → C22`), and with the keep-decision locked (G5) its effort firms to S–M, removing the unbounded-latency gate.                                                                                                                                                                       | backlog "Critical path" + dependency graph   |
| **D3** | C16's "export `CredentialStore` from `mcp/index.ts`" is already done; C09/Z13 disagree on `workspace-context.test.ts` | **Closed.** C16's instruction changed to "**ensure the credential store is part of the documented public surface**" (the export already exists — `mcp/index.ts` exports `SqliteCredentialStore` + `SecretRef` + `CompositeDispatcher` + OAuth helpers). The C09/Z13 `workspace-context.test.ts` contradiction is reconciled: the file is **absent**, so "add one" is correct in both. | backlog C16, C09; Z13-06 reconciliation note |

---

## The console.log correction (called out explicitly per the brief)

The critic's **M2 / follow-up F6** asserted "**two server-path `console.log`
violations** in `workspace-context.ts` and `mcp/store.ts`" that violate the
project's documented anti-flake rule. **This is a false positive.** Re-verified
against `HEAD`: the two matches the critic's grep caught are a **comment** and a
**help/usage string**, not executable `console.log` calls. There are **zero**
executable `console.log` outside `apps/agent/src/cli/` (the legitimate
operator-output exception).

**Therefore the backlog deliberately does NOT contain a "fix two console.log"
task.** The logging work that _is_ warranted — and is captured in **C35** — is:

1. a CI **grep-gate** forbidding `console.log` outside `cli/` (so the documented
   regression that bit CI twice can never recur), and
2. the **structured-logging / per-turn correlation-id** decision (Z16-02) plus the
   **log-level convention** (Z16-03, written into ARCHITECTURE.md by C22).

This is the one place the corrective pass overrides the critic rather than
agreeing with it: the gate is worth adding, but there is nothing to fix.

---

## Net effect

| Before (first draft)                             | After (corrective pass)                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 14 zones                                         | **17 zones** (+ Z15, Z16, Z08-supplement)                                       |
| "252 findings" (wrong)                           | **288 findings** (255 original + 33 gap-fill)                                   |
| 25 chunks                                        | **37 chunks** (+ C26–C37)                                                       |
| 3 unowned source files                           | **0 unowned** — Z15 covers them                                                 |
| 3 dropped findings                               | **0 dropped** — assigned to C10/C12                                             |
| C03 an open keep-or-kill decision                | **C03 = legitimize + document** the kept local-state tier, on the critical path |
| Coverage "verified programmatically" (was false) | Coverage **re-reconciled bidirectionally** (288 zone IDs ⇄ 288 cited)           |
