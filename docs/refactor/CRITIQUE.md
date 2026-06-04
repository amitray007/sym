# Completeness Critique — Sym Refactor Audit

**Date:** 2026-06-02
**Role:** independent completeness critic. This document does **not** re-do the
audit; it stress-tests it. Every claim below was checked against the working
tree at `HEAD` (`686690c`, 2026-06-02) with `find`/`grep`/`git ls-files`. Where I
initially suspected a problem and ground truth disproved it, I say so — a critic
that cries wolf is worse than useless.

The audit (`00-overview.md`, `BACKLOG.md`, `TARGET-STRUCTURE.md`, `ZONES.md`,
`zones/*.md`, `research/*.md`) is genuinely strong: the zone partition is a good
idea, the dependency-ordered chunking is disciplined, and the headline findings
(TUI/secrets contradiction, two Slack clients, oversized files, doc drift) are
real and well-evidenced. The problems below are **completeness and accuracy
defects**, not a rejection of the work. They cluster into four buckets:

1. The disjoint-partition and coverage **guarantees are literally false** — three
   source files are owned by nobody, three findings are dropped, and the test
   zone audited a tree that doesn't match reality.
2. **Whole cross-cutting concerns have no owner**: security end-to-end (esp. the
   interactivity / confirmation trust boundary), logging/observability strategy,
   performance as a system, TUI accessibility, third-party license attribution.
3. A **handful of specific claims are inaccurate or overstated** relative to the
   tree (test count, "rendered manifest committed", which file holds the wrong
   scopes).
4. The **dependency graph has at least one missing edge** (C19 renames a file
   that C15 populates, with no ordering between them).

---

## 1. Gaps — guarantees that don't hold

### G1. The "disjoint partition of the repo" has holes: 3 live source files are owned by no zone

`ZONES.md` claims each zone owns "a non-overlapping slice of files" and that the
14 zones partition the repo. They do not cover it. These **live, imported**
source files appear in **zero** zone reports' owned-file lists:

| File                              | Lines | Imported by               | What it is                                                                                                               |
| --------------------------------- | ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apps/agent/src/confirmations.ts` | 223   | `server.ts`, `pi/loop.ts` | **Destructive-tool confirmation registry** — the Confirm/Cancel button trust boundary behind `POST /slack/interactivity` |
| `apps/agent/src/slack-guard.ts`   | 112   | `pi/loop.ts`              | **LLM relevance guard** — the prompt-injection / private-content-exposure control for broad Slack reads                  |
| `apps/agent/src/assistant.ts`     | 58    | `server.ts`               | Assistant-panel greeting handler (title + starter prompts)                                                               |

That is **393 lines of un-reviewed source**, and two of the three are explicitly
security-sensitive (their own header comments describe owner-gating, crypto-random
ids, fail-open semantics, and private-content exposure). Z04 owns `server.ts` and
Z07 owns `pi/loop.ts`, so these modules are _referenced_ through their importers,
but no reviewer did a dedicated line-by-line pass over them, and no finding ID
targets them. The audit's own coverage premise — "14 zones, each owning a
non-overlapping slice of the repo (config, build, each oversized file or
subsystem, each package, tests, docs)" — is breached.
_Evidence: `grep -rl` over `docs/refactor/zones/` returns 0 for `assistant.ts`,
`slack-guard.ts`, `confirmations.ts`; importers confirmed via
`grep -rln` in `apps/agent/src`._

### G2. The MCP zone (Z08) names only ~4 of its ~13 owned files; several substantial files are unexamined

ZONES.md assigns all of `apps/agent/src/mcp/*` to Z08, but the Z08 report only
references a subset by name. The following MCP source files are **not named** in
Z08 (no file:line evidence, no finding):

| File                                                                           | Lines |
| ------------------------------------------------------------------------------ | ----- |
| `mcp/composite.ts` (`CompositeDispatcher` — the handle-turn integration point) | 41    |
| `mcp/materialize.ts`                                                           | 199   |
| `mcp/providers/static.ts` (static-token transport — the C2 "stop-here" path)   | 278   |

`materialize.ts` (199 lines) and `providers/static.ts` (278 lines) in particular
are large enough to hide exactly the kind of issue the audit hunts for. The
`CompositeDispatcher` is, per the project's own memory, the architectural seam the
whole MCP-client effort was built around — auditing the MCP subsystem without it
is a notable hole.
_Evidence: `grep -l 'composite.ts|materialize.ts|providers/static.ts'
docs/refactor/zones/Z08_` returns 0.\*

### G3. Coverage guarantee is provably wrong — 3 findings are dropped, and the zone count is 255 not 252

`BACKLOG.md` ("Coverage guarantee") and `00-overview.md` both assert **all 252
findings are assigned to exactly one of the 25 chunks — none dropped, none
double-counted — verified programmatically.** Reproducing that check falsifies it:

- Zone reports define **255** unique finding IDs, not 252.
- **3 findings exist in zones but in no backlog chunk:** `Z05-16`, `Z05-17`,
  `Z12-14`. They are dropped on the floor.
- `Z12-14` is especially telling: its own text says _"(not this zone — flagged
  for Z05)"_ — a deliberate cross-zone handoff that **Z05 never picked up** and the
  backlog never captured. The partition's handoff mechanism silently lost a
  finding.

These three are all `low`/`trivial` (a `console.warn` confirmation, an
unnecessary non-null assertion in `web-search.ts:43`, a confusing
`RepliesResponse` reuse at `slack-client.ts:247`), so the _impact_ is small — but
the **"verified programmatically / none dropped" claim is false**, which
undermines trust in the headline guarantee. Either the verifier was never run or
it was run against a different finding set.
_Evidence: `comm -23` of sorted zone IDs vs sorted backlog IDs yields
`Z05-16 Z05-17 Z12-14`._

### G4. The test zone (Z13) audited a tree that doesn't match reality

This is the most serious accuracy defect, because Z13's entire value is its
coverage map. Ground truth: **48 test files** exist (35 in `apps/agent/tests`, 6
in `adapter/slack`, 1 each in contracts/kernel) — not the **53** the overview
claims. More importantly, Z13's enumerated test list is **stale**: it names files
that do not exist and omits files that do.

**Z13 names as existing — but they are ABSENT:**
`workspace-context.test.ts`, `registry.test.ts`, `retry.test.ts`. (It also refers
to `connectors.test.ts`/`commands.test.ts`/`client.test.ts`, which exist only
under prefixed names `admin.connectors`, `cli.commands`, `slack-client` — a
naming imprecision, less severe.)

**These test files EXIST but Z13 does not account for them:**
`confirmations.test.ts`, `slack-guard.test.ts`, `owner-gate.test.ts`,
`safe-fetch.test.ts`, `plan-controller.test.ts`, `assistant.test.ts`,
`assistant-context.test.ts`, `cli.allowlist.test.ts`, `cli.config-store.test.ts`,
`cli.index.test.ts`, `cli.secrets.test.ts`, `mcp.oauth.integration.test.ts`,
`task-card-manager.test.ts`.

Internal contradiction this produces: **C09** says "add `workspace-context.ts`
tests" (correct — the file is absent), while **Z13** lists
`workspace-context.test.ts` as already present. They can't both be right; the file
is absent. A reader trusting Z13 to know what is tested will be misled. The whole
"these tests act as a regression net for C13–C16" argument rests on an inventory
that is wrong.
_Evidence: `find apps packages -path '_/tests/_' -name '_.test*'`(48 files);
per-file`find … -name <X>` confirms each absent/present claim above.*

### G5. The stateless-vs-stateful decision is deliberately left unresolved — and the audit knows it

This is arguably correct process (it's a product call), but it must be named as a
**gap in the deliverable**, because every downstream estimate depends on it.
`TARGET-STRUCTURE.md` §5 and backlog **C03** leave the TUI/CLI/secrets question as
an open Option-A-vs-B decision with an audit _recommendation_ but no resolution.
Consequences the audit under-emphasizes:

- **C03 effort is "M (A) / L (B)"** — a 2× range on a chunk that gates C09, C10,
  and C19. The whole Band-C estimate is unschedulable until the human decides.
- The audit recommends "Option A **minus `SecretsManager`**," but the TARGET tree
  (§6 "after") still draws `tui/` as kept and the backlog never states the _exact_
  surviving file set for the recommended sub-option. A contributor cannot execute
  C03 from the docs alone; they must re-derive the file list.
- `ink`/`react` dependency-tree placement differs between A and B, which changes
  the Docker/`--prod` hardening in C06 — a cross-chunk coupling that isn't drawn
  in the dependency graph.

The ambiguity is _acknowledged_ but not _closed_, and the docs slightly
contradict themselves about the recommended end-state. The single most important
decision in the refactor is the least specified.

---

## 2. Missing coverage — cross-cutting concerns nobody owned

The zone partition is **per-file**, which structurally guarantees that
**whole-system properties have no owner**. The audit has no "cross-cutting"
zone, and synthesis (`00-overview.md` §4 "Top 10 cross-cutting risks") is a
roll-up of per-file findings, not a system-level analysis. Specifically missing:

### M1. End-to-end security posture / threat model

There is **no STRIDE / trust-boundary / attack-surface document** anywhere in the
audit (`grep` for "threat model", "STRIDE", "trust boundary", "attack surface"
across all refactor docs: 0 hits). Security shows up only as scattered per-file
findings (SSRF in C11, token invalidation in C16, the `sym secret` positional
arg). What is _not_ traced end-to-end:

- **The `POST /slack/interactivity` button trust boundary.** `confirmations.ts`
  (unowned, G1) + the interactivity route in `server.ts:382` form the path where a
  Slack button click authorizes a **destructive** tool call. The chain is:
  signature-verify → owner-gate (`server.ts:451`) → parse `action_id` →
  `resolveConfirmation`. No zone audits this as a security flow; no chunk adds an
  adversarial test (forged `action_id`, replayed confirmation id, owner-gate
  bypass, confirmation-after-timeout). For an about-to-be-public agent that can
  post/delete as the owner and run CLIs, this is the highest-value missing review.
- **Prompt-injection posture as a whole.** `slack-guard.ts` (unowned) is the one
  injection/relevance control and it fails open by design. Whether fail-open is
  the right default, and what the blast radius is when it fails, is never analyzed.
- **The owner-gate as a system invariant.** It is tested (`owner-gate.test.ts`)
  and SECURITY.md is promised (C21), but no zone owns "every privileged entry
  point is owner-gated" as a checklist across `/slack/events`,
  `/slack/commands`, `/slack/interactivity`, and the `/admin/*` routes.

C21 produces a `SECURITY.md` listing "token leakage, SSRF, prompt injection," but
that is a _disclosure document_, not a _review_. The review didn't happen.

### M2. Logging / observability strategy

No chunk owns logging as a strategy (`grep` "observability", "logging strategy",
"structured logging", "telemetry": 0 hits in overview/target/backlog). This is a
real gap with two concrete edges:

- **The project's own MEMORY rule** ("server logs never `console.log`; the CLI
  real-wire tests spy on `console.log` and `JSON.parse` it, so server
  `console.log` races into `--json` output — flaky CI, bit twice") is **violated
  in live server code today**: `workspace-context.ts` and `mcp/store.ts` each
  contain a `console.log`. TARGET-STRUCTURE §7 rule 7 states the convention and
  Z09-09 handles the CLI exception, but **no zone/chunk audits or fixes the two
  existing server-path `console.log` calls** — the exact regression the memory
  warns about. (The other 56 `console.log` are in `cli/index.ts`, the legitimate
  operator exception.)
- There is **no structured logger, no request/turn correlation id, no log-level
  strategy** in the codebase (`grep` for pino/winston/requestId/correlationId: 0),
  and the audit neither notes this nor decides whether it's acceptable for OSS.
  With 89 `console.warn` + 20 `console.info` + 14 `console.error` calls scattered
  ad hoc, "how do I debug this in production" has no answer and no owner.

### M3. Performance as a system property

Performance appears only as four isolated micro-findings (Z03-10 fat Docker
image, Z07-10 double allowlist resolve, Z08-08 3× config-file read per call,
Z06-14 double `fieldsFor`, Z05-15 per-call `Agent` allocation). There is **no
analysis of the hot path** (signed event → thread fetch → Pi loop → streamed
reply): no per-turn latency budget, no streaming-throughput consideration, no
bound on thread-context size fetched into the model, no per-turn token/cost
envelope. For an LLM agent, the per-turn cost/latency profile is a first-order
concern and it is unowned.

### M4. TUI accessibility

Zero mentions of accessibility, `NO_COLOR`, color contrast, or screen-reader
behavior anywhere (`grep`: 0). The audit ships a full Ink/React terminal
dashboard (or debates killing it in C03) without ever asking whether it degrades
in a non-TTY/CI/`NO_COLOR`/dumb-terminal environment, or whether its color choices
are legible. If Option A keeps the TUI, this is a real OSS-quality gap; the audit
doesn't even raise it.

### M5. Third-party license attribution / dependency supply chain

The audit covers the project's **own** `LICENSE` (add author name, C21) but never
covers **inbound** third-party license obligations: no NOTICE/attribution file, no
license-compatibility check across `node_modules` (e.g. is anything copyleft
pulled into a to-be-MIT/Apache project?), no SBOM, no `dependabot`-beyond-Actions
supply-chain posture for the runtime deps (`@modelcontextprotocol/sdk`, `ink`,
`hono`, the Slack/Fireworks SDKs). For an OSS launch this is part of "community
health" and R2 doesn't appear to have produced it. C21 adds `dependabot.yml` for
**Actions** only.

### M6. The dependency graph "as a whole" is asserted, not audited as an artifact

The DAG (`contracts ← kernel/adapter ← agent`) is real — I verified there are **no
runtime cross-package import violations** (only doc-comment references cross
packages). So the _claim_ is accurate. But the audit never produces the actual
dependency graph as an artifact (the C07 dependency-cruiser output is proposed,
not generated), so "acyclic and correctly layered" is currently a **manual
assertion** the reader must take on faith until C07 lands. Given the audit's own
thesis is "make structure enforceable, not convention," shipping the audit without
the generated graph is a small but ironic gap.

---

## 3. Unverified / inaccurate claims (asserted without, or against, evidence)

The audit is mostly well-evidenced (per-finding file:line is its strength). These
specific synthesis-level claims do **not** hold up against the tree:

### U1. "53 test files" — actual count is 48

`00-overview.md` §2: "53 test files." Ground truth: **48**. Off by five, and the
discrepancy correlates with Z13's stale inventory (G4). A wrong denominator
distorts every coverage statement built on it.

### U2. "rendered `slack/manifest.yml` with a personal ngrok URL" is committed — it is NOT

TARGET-STRUCTURE §6 "before" tree, Z03-07, and C21 all frame a rendered
`slack/manifest.yml` containing a personal ngrok URL as a committed launch risk
("verify it is untracked, `git rm --cached` if not"). Ground truth:
`git ls-files slack/` returns only `slack/README.md` and
`slack/manifest.template.yml`. **The rendered manifest is not tracked and does not
exist in the tree.** The C21 task is therefore largely a no-op as written, and the
"before" tree depicts a risk that isn't present. The _defensive_ recommendation
(add a CI check blocking committed rendered manifests) is still fine — but the
stated present-tense risk is unverified and, as of `HEAD`, false.
_Evidence: `git ls-files slack/`._

### U3. "wrong Slack scopes" is located imprecisely — the manifest template is CORRECT; only the README is wrong

The overview/backlog repeatedly say "wrong Slack scopes (`im:write` instead of
`im:read`), missing `commands` and `assistant:write`." This is **true of
`README.md:45`** (which lists `im:write` and omits `commands`/`assistant:write`),
but **false of `slack/manifest.template.yml`**, which already contains `im:read`,
`commands`, `assistant:write`, and the `assistant_thread_*` events. The recommended
fix (point README at `pnpm manifest:render` as the single source of truth) is
**correct and well-aimed**. But the docs never pin the defect to README
specifically, leaving the impression the manifest is also wrong. Precision here
matters because C20's whole premise is "the manifest is the source of truth" — a
reader needs to know the manifest is already right.
_Evidence: scopes present at `slack/manifest.template.yml:64,88,90,124-125`;
wrong list at `README.md:45`._

### U4. "~28,200 source lines" conflates source with tests

§2 cites "~28,200 source lines (113 `.ts` + 12 `.tsx`)." The 113+12 figure
**includes test files**. Actual **non-test** source is ~15,700 lines
(`apps/agent/src` = 13,530; the three packages' `src` ≈ 2,170). The "28,200"
number (≈27,740 by my count incl. tests) is the source+test total. Minor, but the
label "source lines" is inaccurate and inflates the apparent surface a newcomer
must read by ~80%.

### U5. "the env-var table documents 9 … the agent actually reads ~18+"

Directionally correct but loosely evidenced. README documents **8** required/
optional vars in its table (plus `SYM_OWNER_SLACK_USER_ID` referenced in prose =
9). The agent reads ~**15** distinct names by direct `process.env` grep, climbing
toward "18+" only once you count the MCP/CLI knobs read ad hoc across `mcp/` and
`pi/` (`SYM_CLI_ALLOWLIST`, `SYM_CLI_CONFIRM`, `SYM_DB_PATH`, `SYM_PUBLIC_URL`,
`SYM_MCP_CONNECT_TIMEOUT_MS`, `SYM_ADMIN_URL`, …). The **conclusion stands** (many
undocumented vars), but "18+" is presented as if counted and isn't; the real,
defensible figure is "≥15 read, 9 documented."

---

## 4. Dependency-ordering defects (chunks whose order could break or under-specify the build)

The backlog's ordering is mostly sound and I found **no edge that would hard-break
the build** in the strict sense. But there are correctness gaps in the graph:

### D1. C19 renames `thinking-copy.ts`, but C15 is the chunk that _populates_ it — and C19 doesn't depend on C15

- **C15** moves `WHIMSY_WORDS`/`nextWhimsicalStatus` **into** `thinking-copy.ts`.
- **C19** **renames** `thinking-copy.ts → shimmer-phrases.ts`.
- **C19's declared dependencies are C12, C03, C14** — _not C15_. Its note says
  "C14 (`thinking-copy` rename coordinates with the `handle-turn` import)," but
  C14's scope is `handle-turn.ts`/`server.ts`; the content that lands in
  `thinking-copy.ts` comes from **C15**.

So the two chunks that both target `thinking-copy.ts` along different axes (one
fills it, one renames it) have **no ordering relationship**. If C19 runs before
C15, C15 then writes `WHIMSY_WORDS` into a file C19 already renamed away (merge
friction / a resurrected `thinking-copy.ts`). The missing edge **C19 → C15**
(or folding the rename into C15) should be added. This is exactly the class of
parallel-execution conflict the zone map is supposed to prevent, and it slipped
because both chunks are "Z05/Z07 polish" but touch a shared file.

### D2. C03 is a decision gate with a 2× effort range that blocks the critical path, but isn't on the drawn critical path

The "Critical path: C04 → C07 → C10 → C16 → C20 → C22" omits **C03**, yet C09,
C10, and C19 all `Depends on: C03`, and C03's outcome swings their scope. A
human-decision gate with unbounded latency sitting upstream of three structural
chunks is a scheduling risk the dependency-graph section doesn't surface. C03
should be shown as a gating predecessor on the critical-path diagram.

### D3. Several chunks describe work the tree shows as partially done — risk of "re-doing" or stale instructions

Not ordering-breaking, but execution-confusing:

- **C16** says "export `CredentialStore` from `mcp/index.ts`." `mcp/index.ts`
  already exports `SqliteCredentialStore` (+ `SecretRef`, `CompositeDispatcher`,
  OAuth helpers). The chunk's instruction is written as if the barrel is bare;
  whoever executes it must reconcile against the current export set.
- **C09 / Z13** disagree on whether `workspace-context.test.ts` exists (it does
  not). An executor reading Z13 first may skip the C09 task believing it's done.

These are symptoms of the audit being written against a slightly **stale snapshot**
(consistent with U1/G4). Re-baselining the inventory before execution would catch
them.

---

## 5. Concrete follow-up tasks to close the gaps

Ordered by value. Each is phrased to be directly actionable; IDs are suggestions
for slotting into the existing backlog.

**Coverage repair (do first — restores trust in the guarantees):**

1. **F1 — Add a zone (or extend Z04/Z07) for the 3 unowned files.** Do a
   dedicated review of `confirmations.ts`, `slack-guard.ts`, `assistant.ts` with
   file:line findings. Treat `confirmations.ts` as security-critical.
2. **F2 — Extend Z08 to the unnamed MCP files** `composite.ts`,
   `materialize.ts`, `providers/static.ts` (and confirm `providers/oauth.ts`,
   `oauth-registry.ts`, `inject.ts` got real passes, not just mentions).
3. **F3 — Re-run the coverage verifier and assign the 3 dropped findings**
   (Z05-16, Z05-17, Z12-14) to chunks (they fit C10 dead-code / C19 polish /
   C12 Slack-client respectively). Fix the overview's "252 / none dropped" text to
   the true number, or genuinely close the gap to 255-of-255.
4. **F4 — Re-baseline Z13 against the real 48-file test tree.** Remove phantom
   entries (`workspace-context.test.ts`, `registry.test.ts`, `retry.test.ts`),
   add the ~13 omitted real files, and reconcile C09 with the corrected inventory.

**Cross-cutting concerns (the structural blind spots):**

5. **F5 — Write an end-to-end security review** (its own doc, not just
   `SECURITY.md` disclosure): STRIDE over the four privileged entry points
   (`/slack/events`, `/slack/commands`, `/slack/interactivity`, `/admin/*`), with
   the interactivity→confirmation→destructive-tool chain as the centerpiece. Add
   adversarial tests (forged/replayed `action_id`, owner-gate bypass,
   confirmation-after-timeout). New chunk; depends on F1.
6. **F6 — Add a logging/observability chunk.** Fix the two server-path
   `console.log` calls (`workspace-context.ts`, `mcp/store.ts`) that violate the
   project's documented anti-flake rule; decide on (and document) a log-level
   convention and whether a turn-correlation id is in scope. Add a CI grep gate
   forbidding `console.log` outside `cli/`.
7. **F7 — Add a hot-path performance note** to ARCHITECTURE.md (C22): per-turn
   latency budget, thread-context size bound, streaming-throughput and per-turn
   cost envelope. Roll the existing micro-findings (Z03-10, Z07-10, Z08-08,
   Z06-14, Z05-15) under it so they're framed systemically.
8. **F8 — If Option A keeps the TUI, add a TUI-accessibility check**: `NO_COLOR`
   honored, degrades in non-TTY/CI, color-contrast sanity. Fold into C03/C19.
9. **F9 — Add third-party license attribution / supply-chain coverage**: generate
   a license report across runtime deps, add NOTICE/attribution if required,
   extend `dependabot.yml` from Actions to the npm ecosystem, consider an SBOM.
   Slot under C21.

**Accuracy fixes (cheap, high-trust-payoff):**

10. **F10 — Correct the inaccurate synthesis claims:** "53 → 48 test files";
    relabel "28,200 source lines" as source+test (true non-test ≈ 15,700); pin
    the wrong-scopes defect to `README.md:45` and state explicitly that the
    manifest template is already correct; downgrade "rendered manifest.yml is
    committed" to "ensure it never gets committed (it currently isn't)"; restate
    the env-var gap as "≥15 read / 9 documented."

**Dependency-graph fixes:**

11. **F11 — Add the missing edge C19 → C15** (or merge the `thinking-copy.ts`
    rename into C15 so the file is renamed _after_ it's populated). Show **C03**
    as a gating predecessor on the critical-path diagram. Re-verify C16's
    `mcp/index.ts` instruction against the current export set.

---

## 6. What I checked and found _accurate_ (so the team can trust these)

To keep this critique honest and bounded:

- **The dependency DAG is genuinely acyclic and correctly layered** — no runtime
  cross-package import violations (`contracts` imports no `@sym/*`; `kernel`/
  `adapter` import only `@sym/contracts`; nothing imports from `apps/`). Only
  doc-comments cross the boundary.
- **The five oversized-file line counts are exact** (`builtin-tools.ts` 1679,
  `handle-turn.ts` 1057, `server.ts` 804, `pi/loop.ts` 734, `mcp/dispatcher.ts`
  652, `slack-client.ts` 570, adapter `client.ts` 520).
- **Secret hygiene is fine, contrary to the alarm:** `.env` and
  `apps/agent/.sym/credentials.db` are untracked and covered by `.gitignore`.
- **The two-Slack-clients finding is real** (concrete impl in
  `apps/agent/src/slack-client.ts`, interface/types/retry in the adapter package).
- **The TUI/secrets North-Star contradiction is real** — `tui/SecretsManager.tsx`,
  the `sym secret` CLI verbs, and the SQLite store all exist; the 5 `tui.*` test
  files exist (named `tui.dashboard.test.tsx` etc., which is why a naive search for
  `dashboard.test.tsx` misses them — that's a Z13 naming imprecision, not a
  fabrication).
- **`apps/agent/src` is exactly 13,530 source lines** as claimed.

The audit's bones are good. Close G1–G4 (coverage), own M1–M2 (security +
logging), and fix the U-series wording, and this becomes the exemplary,
trustworthy refactor map it's trying to be.
