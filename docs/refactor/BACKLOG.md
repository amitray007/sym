# Refactor Backlog — the execution plan

This is **the deliverable**: the **288** per-zone findings de-duplicated into **37
dependency-ordered chunks** (the original C01–C25 plus the corrective-pass
C26–C37). Each chunk is _one working thing with a clear
end-state_ — not a phase, not a version. The ordering guarantees that **every
chunk leaves the build green and the app working**, so the program can stop at
any chunk boundary and still ship.

> **Corrective pass (2026-06-02).** This backlog was rewritten after a
> completeness critique ([`CRITIQUE.md`](./CRITIQUE.md)) and three gap-fill
> reviews (Z15 security, Z16 cross-cutting, Z08-supplement). The headline numbers
> changed: **288 findings across 17 zones** (the old "252 / 14 zones" undercounted
> by miscounting Z05/Z12 and predates the gap-fill zones). The single biggest
> change is **C03**: the TUI/CLI/SecretsManager/SQLite credential store is now a
> **first-class, intentional local-state control tier** — C03 is recast from
> "decide keep-or-kill" to "legitimize + document." See
> [`CRITIQUE-RESOLUTION.md`](./CRITIQUE-RESOLUTION.md) for the full critique-item
> ledger.

**How to read a chunk:**

- **Goal / end-state** — what is true when the chunk is done.
- **Resolves** — the finding IDs it closes (open the matching `zones/Znn-*.md`
  for evidence). Every one of the 288 findings appears in exactly one chunk.
- **Zones touched** — which audit zones' owned files it reaches (for parallel-
  execution conflict avoidance; see [`ZONES.md`](./ZONES.md)).
- **Depends on** — chunks that must land first.
- **Effort** — S (≤½ day), M (½–2 days), L (>2 days).
- **Blast radius** — `isolated` (one file/dir), `package` (one package's
  consumers), `cross-unit` (a contract/interface multiple units depend on).

**⚠ cross-unit chunks** (C12, C17, C18) change a shared contract or interface.
Run the [`cross-unit-impact`](../../.claude/skills/cross-unit-impact/SKILL.md)
checklist **before** writing the change and again before opening the PR — name
every consumer, confirm backward compatibility, and update all consumers in the
same change.

**Ordering rationale:** quick wins first (the repo stops lying about itself, at
near-zero risk) → instrumentation (so the structural work is guarded) → the
local-state legitimization and the structural splits → security/observability/
performance hardening → docs & OSS-readiness last (they describe the now-final
structure). Within each band, lower risk precedes higher.

---

## Band A — Quick wins (purge, document, tighten)

Low-risk, high-signal. These delete dead weight and make the repo honest. They
touch mostly disjoint files and can run **in parallel**. None changes runtime
behavior except C06.

### C01 — Purge dead-architecture artefacts from config & scripts

**Goal:** no tooling/config/script file references a removed feature (Postgres,
Redis, Drizzle, encryption-key bootstrap, _web_ dashboard, audit, OTel, deleted
commit scopes). `scripts/` contains only `render-manifest.js` plus a new minimal
`setup.sh` (install + copy `.env.example`). `commitlint` scope-enum lists only
live scopes at **error** level. `.gitignore`, `.prettierignore`, `.vscode`
recommendations, the `if: false` evals CI job, and the PR template's
schema/OTel/stream sections are all cleaned.

**Resolves:** Z01-02, Z01-08, Z01-09, Z01-13, Z02-02, Z02-03, Z02-04, Z02-10,
Z02-14, Z02-15, Z02-17, Z02-19, Z03-01, Z03-02, Z03-17, Z03-19, Z14-04, Z14-05,
Z14-11
**Zones touched:** Z01, Z02, Z03, Z14 · **Depends on:** — · **Effort:** S ·
**Blast radius:** isolated
_(Two of these — `dev-setup.sh`/`setup-_.sh`and the schema/OTel PR-template
sections — are`critical`/`high`: a contributor following them hits a hard
failure today. NB: the dead-architecture features being purged here are the
removed _web_ dashboard / Postgres / Redis / audit subsystems — **not** the
operator CLI or the SQLite credential store, which are intended and kept; see
C03.)\*

### C02 — Document every env var the agent reads

**Goal:** every variable read anywhere in `apps/agent/src` has a documented
entry. `.env.example` gains an MCP/connectors section with all currently-missing
vars (`SYM_ENCRYPTION_KEY`, `SYM_PUBLIC_URL`, `SYM_DB_PATH`, `SYM_MCP_SERVERS`,
`SYM_CONFIG_PATH`, `SYM_MCP_CONNECT_TIMEOUT_MS`, `SYM_CLI_ALLOWLIST`,
`SYM_CLI_CONFIRM`, `SYM_ADMIN_URL`, `SLACK_OWNER_USER_TOKEN`,
`TASK_CARD_AFTER`, `TASK_CARD_THRESHOLD`, `OWNER_POST_MARKER`, behavior knobs).
`dokploy/env-template.txt`, `dokploy/apps/agent.yml`, and the
`docker-compose.yml` header comment are made consistent with it and with the
code. The README baseline is **9 documented vs ≥15 read in code** — this chunk
closes that gap to zero.

**Resolves:** Z03-03, Z03-04, Z03-05, Z03-08, Z03-18, Z04-05, Z07-12, Z08-15,
Z09-06, Z14-02, Z14-13, Z14-14, Z14-16, Z14-32
**Zones touched:** Z03, Z04, Z07, Z08, Z09, Z14 · **Depends on:** — ·
**Effort:** M · **Blast radius:** isolated
_(Documentation-only here; the matching code change — routing these knobs through
`config.ts` instead of scattered `process.env[]` — is folded into the relevant
structural chunks C15/C16. This chunk guarantees discoverability regardless.)_

### C03 — Legitimize and document the local-state control tier (TUI / CLI / SQLite credential store)

**Goal:** Sym's **intentional local-state control tier** is coherent, honestly
documented as first-class architecture, and no longer contradicted by stale
"no dashboard / no secrets store" copy. **This is no longer a keep-or-kill
decision — the owner has decided to KEEP all of it** (see
[`TARGET-STRUCTURE.md`](./TARGET-STRUCTURE.md) §5). "Stateless" describes the
_conversational_ memory (no message DB — the Slack thread is the memory); it has
never meant "no operator tooling." The surviving tier is:

- **`apps/agent/src/tui/`** — the Ink/React operator dashboard (`Dashboard`,
  `DetailScreen`, `BuilderScreen`, `SecretsManager`, `App` router). **Kept.**
- **`apps/agent/src/cli/`** — the `sym` operator CLI (`status / connector / apply
/ secret` verbs + admin-client + config-store). **Kept.**
- **`apps/agent/.sym/credentials.db`** — the AES-256-GCM-encrypted SQLite store
  (`mcp/store.ts`) backing MCP OAuth tokens. **Kept** (already non-optional).

Concrete work (no deletion of the tier):

1. **Re-frame the docs to match reality.** README "no database, no dashboard" →
   "no message database and no _web_ dashboard; Sym ships an operator TUI + CLI
   and an encrypted local credential store as a deliberate control tier."
   FUTURE.md's "the collapse removed Secrets / Dashboard" line is corrected to
   describe what was actually removed (the multi-service Postgres web dashboard),
   and to acknowledge the rebuilt-in-agent MCP client + operator CLI + credential
   store. Add an **ARCHITECTURE tier explanation** (lands fully in C22): two tiers
   — _conversational_ (stateless, thread-as-memory) and _control_ (local-state:
   TUI/CLI + encrypted SQLite).
2. **Move `ink`/`react`/`ink-text-input` to `devDependencies`** _only if_ the
   Hono server runtime never imports them at boot (verify: the TUI is launched by
   the `sym` CLI, not the server). If the server path does import them, keep them
   as runtime deps and document why. _(Z09-13 — verify before moving; this is the
   one coupling that touches the C06 `--prod` hardening.)_
3. **Harden the credential CLI surface:** `sym secret set` no longer accepts a
   plaintext value as a positional arg (stdin-only) — a secret in argv leaks via
   the process table. _(Z09-14.)_
4. **The 5 `tui.*` test files are KEPT** and gain a real-wire smoke test for the
   surface they cover (they are _not_ dead-code tests under the reframe). _(Z13-01
   re-cast — see C09 for the smoke test; remove the "delete these" framing.)_

**Resolves:** Z09-01, Z09-08, Z09-13, Z09-14, Z09-15, Z13-01, Z08-03, Z14-06,
Z14-12
**Zones touched:** Z09, Z13, Z08, Z14 · **Depends on:** — · **Effort:** S–M ·
**Blast radius:** package
*(**On the critical path** — C09, C10, and C19 all touch `tui/`/`cli/` files and
depend on this chunk settling their scope. Effort firmed to S–M now that the
keep-decision is locked: no Option-B deletion branch, no 2× range. Z09-01 and
Z13-01 were `critical` *as contradictions*; the contradiction is resolved here by
documentation + reframe, not deletion.)*

### C04 — Delete stale `dist/` artefacts and add a prebuild clean step

**Goal:** no package ships compiled output for deleted source. Remove
`packages/contracts/dist/{audit,connectors,memory,sandbox,soul}.*`,
`packages/kernel/dist/{soul,tone,loop}.*`, and
`packages/adapter/slack/dist/dedup.*`. Add a `clean` (or `tsc --build --clean`)
prebuild step to all three packages so deleted source can never leave orphaned
`.d.ts` behind. Add `dist/` to the gitignore / keep it out of source review.

**Resolves:** Z01-11, Z10-02, Z11-01, Z12-01
**Zones touched:** Z01, Z10, Z11, Z12 · **Depends on:** — · **Effort:** S ·
**Blast radius:** package

### C05 — Make the type-safety lint guard real

**Goal:** `@typescript-eslint/no-explicit-any` is `error` (at least for
`packages/**`), and `--max-warnings 0` is enforced in every ESLint invocation
(CI + lint-staged), so `any` casts and warnings can no longer pass silently. The
~3 legitimate non-test `as any` sites in `pi/tools.ts` and `pi/meta-tools.ts` are
fixed with a named `passthrough` helper / `toRecord` narrowing. `noUnusedLocals`
and `noUnusedParameters` are enabled (the `_`-prefix convention satisfies them).
The test-file `any`-off override is preserved.

**Resolves:** Z02-01, Z02-09, Z02-11, Z02-12, Z02-16, Z07-05, Z07-08
**Zones touched:** Z02, Z07 · **Depends on:** — · **Effort:** S ·
**Blast radius:** cross-package
_(Do this before the structural splits so the refactors can't introduce new
`any`. The `complexity`/`max-lines`/`max-depth`/`max-params` rules from R3 land
in C07 as `warn`, promoted to `error` in C24 after the oversized files are split.)_

### C06 — Production runtime & container hardening

**Goal:** a `pnpm install --prod` build cannot break startup, and the runtime
image is lean and self-monitoring. Move `dotenv` from `devDependencies` to
`dependencies` (it is imported in `src/index.ts`). Add `pnpm prune --prod` so the
runtime stage ships only production `node_modules` + `dist/` (no `vitest`, `tsx`,
TS source). Pin the base image (`node:24-slim` → digest/patch). Add a
`HEALTHCHECK` (curl `/health`). Add `dev/`, `tmp/`, `.claude/` to `.dockerignore`.
Read CI Node from `.nvmrc`. Remove the stale `apps/agent/Dockerfile` TODO.

**Resolves:** Z03-09, Z03-10, Z03-14, Z03-15, Z03-16, Z02-06, Z02-07
**Zones touched:** Z03, Z02 · **Depends on:** C03 (the `ink`/`react` dependency-
tree placement from C03 step 2 determines what `--prod` ships) · **Effort:** M ·
**Blast radius:** isolated
_(`Z03-09` dotenv-misclassification is the one with real bite — a `--prod` deploy
breaks today. The C03 dependency is the cross-chunk coupling the original graph
missed: if the TUI stays a runtime dep, `--prod` must keep `ink`/`react`.)_

### C07 — Add structural enforcement (knip, dependency-cruiser, boundary rules, size limits)

**Goal:** package isolation and the dependency DAG stop being convention-only.
Add `knip` (dead exports/files/deps) and `dependency-cruiser` (`no-circular`,
`no-orphans`, `packages-not-to-apps`) with CI steps, and **commit the generated
dependency graph** so "acyclic and correctly layered" stops being a manual
assertion (closes critique M6). Add ESLint `no-restricted-imports` forbidding
`packages/** → apps/**`, `import/order` `pathGroups` treating `@sym/*` as
internal, and the R3 size/complexity rules (`max-lines` 400, `complexity` 15,
`max-depth` 4, `max-params` 4) at **warn**. Hoist `vitest` to a root `pnpm`
catalog. Add `sideEffects: false` and OSS metadata (`repository`, `author`,
`description`) to the three packages and root.

**Resolves:** Z02-08, Z02-13, Z01-06, Z01-07, Z01-10, Z01-12
**Zones touched:** Z02, Z01 · **Depends on:** C04 (clean `dist/` so knip/depcruise
don't trip on stale artefacts), C03 (so `tui/`/`cli/` are known-kept and knip
doesn't flag the operator tier as orphan dead code) · **Effort:** M ·
**Blast radius:** cross-package
_(R1.4–R1.7, R3.2–R3.4. Baseline the knip/depcruise reports before turning them
into hard CI fails — they may flag the dead code that C10 then removes. The
operator CLI/TUI must be on knip's entry-points list so the kept tier isn't
misreported as dead.)_

---

## Band B — Instrumentation (guard the structural work)

These add the measurement and test coverage that make the Band C refactors safe.

### C08 — Add coverage instrumentation and split unit vs integration runs

**Goal:** every `vitest.config.ts` has v8 coverage (line/branch thresholds, LCOV
reporter); CI uploads coverage. A `vitest.config.integration.ts` separates the
slow/subprocess real-wire tests (`*.integration.test.ts`, 30s timeouts) from
sub-millisecond unit tests; `pnpm test` runs unit-only, `pnpm test:integration`
runs the slow suite, and CI runs them as separate steps. The blind spots the
other test chunks fill become _measured_.

**Resolves:** Z13-02, Z13-07
**Zones touched:** Z13 · **Depends on:** — · **Effort:** S ·
**Blast radius:** cross-package
_(Z13-02 is `critical` — without coverage, every gap below is invisible.)_

### C09 — Fill the highest-risk test gaps (dispatch, server routes, boot, packages, operator surface)

**Goal:** the untested security-sensitive and boot-critical paths get coverage
_before_ they are refactored. Add dispatch tests for `run_cli`, `set_plan`,
`update_task` (the three most security-sensitive tools, currently zero coverage);
**`workspace-context.ts` tests (the file has NO test today — confirmed against
the 48-file tree; this is a genuine add, not a duplicate)**; `packages/kernel`
`ToolRegistry` + `buildReceipt` tests; `packages/adapter/slack` `retry.ts`
(`withSlackRetries`/`mapSlackError`) tests; contracts `RenderIntent` type-level
assertions; the `server.ts` `assistant_thread_context_changed` / loopback-guard /
OAuth-callback route tests; and a **real-wire smoke test for the kept operator
CLI/TUI surface** (C03 keeps all of it).

**Resolves:** Z06-05, Z13-03, Z13-05, Z13-06, Z13-09, Z13-10, Z13-11, Z13-15,
Z08-20, Z09-07
**Zones touched:** Z06, Z13, Z08, Z09, Z11, Z12 · **Depends on:** C08, C03 (the
CLI/TUI smoke-test scope follows the kept tier) · **Effort:** L ·
**Blast radius:** package
_(These tests are written against the **current** code so they act as a
regression net for C13/C14/C16/C19. Cite-and-pin behavior before moving it. NB:
the adversarial **`POST /slack/interactivity`** tests are NOT here — they are the
dedicated security chunk C26.)_

---

## Band C — Structural (the real refactor)

The core work. Ordered so dead code is removed first (smaller surface to move),
then the contract-touching fixes, then the big file splits.

### C10 — Global dead-code sweep (orphan fields, exports, unreachable branches, ghost comments)

**Goal:** one pass removes the long tail of confirmed dead code across all zones:
unread config fields (`taskCardAfter`, `WorkspaceContext.mcpServers`), unused
exports (`statusColor`, `fetchStatus`, `hasTools`, `buildTurnContextPrompt`,
`ReceiptParams`, `denyReason`), unreachable branches (`pickThinkingLevel` third
branch, `withSlackRetries` post-loop throw, dummy `new Client()` allocations),
speculative type members (`ThinkingLevel.'high'`, `Turn.entrySurface.'task'`,
`ToolDescriptor.type`), the unnecessary non-null assertion in `web-search.ts:43`
(**Z05-17**), and ghost/stale planning comments ("Phase B", "chunk 3", detached
`heroRenderParts` JSDoc, dead spec references, `Model A/B`, internal chunk IDs in
docs). Replace internal planning labels with plain-English descriptions
throughout.

**Resolves:** Z03-13, Z04-04, Z04-08, Z04-09, Z04-10, Z04-11, Z05-09, Z05-13,
Z05-14, Z05-17, Z06-08, Z07-04, Z07-09, Z07-14, Z08-04, Z08-09, Z08-11, Z08-12,
Z08-16, Z09-02, Z09-03, Z09-16, Z09-18, Z09-19, Z09-20, Z10-09, Z10-10, Z11-04,
Z11-05, Z11-07, Z11-13, Z12-10, Z14-15, Z14-21, Z14-29, Z14-33
**Zones touched:** Z03, Z04, Z05, Z06, Z07, Z08, Z09, Z10, Z11, Z12, Z14 ·
**Depends on:** C07 (knip confirms each removal is truly unused), C03 (so
`tui/`/`cli/` are known-kept — only genuinely-dead lines inside the kept tier are
swept, not the tier itself) · **Effort:** M · **Blast radius:** package
_(Knip from C07 is the safety check: nothing here is removed without confirming
it has no live consumer. **Z05-17** is one of the three findings the old backlog
dropped on the floor — now assigned. Each removal is a separate commit so any
mistaken deletion is trivially revertable.)_

### C11 — Add SSRF / URL-validation defense-in-depth

**Goal:** every place that forwards a URL to `fetch()` validates it first.
`postToResponseUrl` rejects URLs not starting with `https://hooks.slack.com/`.
The `safe-fetch.ts` IPv6 blocklist gains multicast (`ff00::/8`), documentation
(`2001:db8::/32`), and NAT64 (`64:ff9b::/96`) ranges with RFC citations. The MCP
HTTP transport URL is validated at config-parse/connect time (require https for
non-localhost; warn on RFC-1918/link-local). CSRF state comparison uses
`node:crypto.timingSafeEqual`. Malformed MCP `inputSchema` is structurally
checked before casting. Each new guard gets a test.

**Resolves:** Z04-07, Z05-07, Z05-08, Z08-06, Z08-13, Z08-17
**Zones touched:** Z04, Z05, Z08 · **Depends on:** — · **Effort:** M ·
**Blast radius:** isolated
_(Independent of the file splits — can run any time after Band A. Front-loaded
because it is security-relevant for a public codebase. The broader end-to-end
trust-boundary review and adversarial interactivity tests are C26.)_

### C12 — Consolidate into a single Slack client in the adapter package

**Goal:** one Slack client, living in the package it implements. Move
`WebApiSlackClient` from `apps/agent/src/slack-client.ts` into
`packages/adapter/slack/src/web-api-client.ts`; delete the app file; point
`workspace-context.ts` at `@sym/adapter-slack`. Split the 520-line `client.ts`
into `types.ts` + `client.ts` (interface only) + `retry.ts`. This eliminates the
duplicate `SlackWebApiError`, lets the empty-string branded-id casts be fixed
once (throw on guaranteed fields, filter optional ones), stops re-exporting the
internal `mapSlackError`, and exports `VerifyResult`. Move the three
`NameResolver` static ID predicates to standalone `isSlackUserId` /
`isSlackChannelId` / `isSlackDmId` exports. **Also fixes the confusing
`RepliesResponse` reuse for the history endpoint (`slack-client.ts:247`,
Z05-16)** and the `usersList` status-field omission (Z12-07) as part of moving
the impl.

**Resolves:** Z05-01, Z05-02, Z05-03, Z05-05, Z05-06, Z05-16, Z12-02, Z12-05,
Z12-07, Z12-11, Z12-14
**Zones touched:** Z05, Z12 · **Depends on:** C04 (clean `dist/`) ·
**Effort:** M · **Blast radius:** ⚠ cross-unit
_(**Run the cross-unit-impact checklist.** This moves a public package surface;
name every `@sym/adapter-slack` and `slack-client` importer (the predicates have
6 call sites across `handle-turn.ts` and `builtin-tools.ts`) and update them in
the same change. C09's `retry.ts` tests guard the retry move. **Z05-16 and
Z12-14** are two of the three findings the old backlog dropped — both are
`slack-client.ts` concerns and land here; **Z12-14**'s own text was a deliberate
"flagged for Z05" handoff that the old partition silently lost.)_

### C13 — Split `builtin-tools.ts` into a `tools/` registry

**Goal:** the 1679-line monolith becomes a `tools/` directory: one file per tool
family + a `registry.ts` Map-based dispatch table + a `_helpers.ts` of extracted
primitives (`argError`, `execError`, `errMsg`, `clampedLimit`, `coercePairs`,
`fieldsFor`). The 866-line if/else `dispatch` becomes a ~10-line lookup reusing
`DESCRIPTORS_BY_NAME`. The 26× arg-error / 11× err-extraction / 18× cast
boilerplate collapse into helpers. `fieldsFor` is called once per match (not
twice) and unit-tested across its three branches. `builtin-tools.ts` is a ~50-line
wiring file. A module-level JSDoc replaces the C-style separators.

**Resolves:** Z06-01, Z06-02, Z06-03, Z06-04, Z06-06, Z06-07, Z06-09, Z06-10,
Z06-11, Z06-12, Z06-13, Z06-14, Z06-15, Z06-16, Z06-17
**Zones touched:** Z06, Z13 · **Depends on:** C09 (dispatch tests for the
4 untested tools must exist first so the split is regression-guarded), C05 ·
**Effort:** L · **Blast radius:** package
_(R3.5. The single largest structural win. The C09 dispatch tests are the safety
net; extraction is behavior-preserving and the tests stay green throughout.)_

### C14 — Decompose `handle-turn.ts` and `server.ts`

**Goal:** the two orchestration files drop below ~300 lines each by extracting
modules along concern boundaries. From `handle-turn.ts` (1057):
`task-card-manager.ts`, `turn-context.ts` (history + viewed-channel resolvers),
`stream-reply.ts` (three named delivery helpers + direct unit tests). From
`server.ts` (804): a single `verifySlack` middleware (replacing the 3× copy-paste
signature check), `event-router.ts` (the two 100-line `processEvent` /
`processSlashCommand` closures), a `rawEventToTurn` helper, and a unified
bounded-LRU evictor. `replySink.blocks` is typed `SlackBlock[]`. Adds the missing
`response_url` fallback-path server test.

**Resolves:** Z04-01, Z04-02, Z04-03, Z04-06, Z04-12, Z04-13, Z04-14, Z04-15,
Z04-16, Z04-17
**Zones touched:** Z04 · **Depends on:** C09 (server route tests), C12 (the
`SlackBlock[]` typing of `replySink` aligns with the consolidated client) ·
**Effort:** L · **Blast radius:** package
_(`TaskCardManager` is imported by tests from `handle-turn.ts` — updating the
import path is the only consumer change.)_

### C15 — Decompose `pi/loop.ts` and clean up its public surface

**Goal:** `runLoopPi` drops to ≤150 lines by extracting `buildAgentTools`,
`buildAgentSystemPrompt`, `makeBeforeToolCall` (the 98-line closure becomes a pure
function), and `makeSubscriber`. **`WHIMSY_WORDS`/`nextWhimsicalStatus` move out
of `loop.ts`'s public surface into `thinking-copy.ts`** (consumed by
`handle-turn.ts`). `resolveAllowlist` is called once per turn (not 3×). The
`AbortSignal` listener is removed in a `finally`. `SYM_CLI_CONFIRM` is routed
through `BehaviorConfig`. The duplicate `searchDescriptors`/`searchCli` ranking
and the triplicated MCP-name splitting are unified (`rankByTerms`, `parseMcpName`).
Adds `toAgentMessages` / `extractUsage` / abort-wiring unit tests.

**Resolves:** Z07-01, Z07-06, Z07-07, Z07-10, Z07-11, Z07-13, Z07-16, Z07-17
**Zones touched:** Z07 · **Depends on:** C05 (the `as any`/`as Record` fixes land
first), C09 · **Effort:** L · **Blast radius:** package
*(**C15 populates `thinking-copy.ts`** (moves `WHIMSY_WORDS` in); the rename to
`shimmer-phrases.ts` in C19 therefore now **depends on C15** — see the dependency
graph. This closes critique D1: the file is renamed only *after* it is populated.)*

### C16 — Split the MCP dispatcher and untangle `mcp/source.ts`

**Goal:** `mcp/dispatcher.ts` (652) splits into `pool.ts` (pool + `McpDispatcher`

- `initMcpPool`), `reconcile.ts`, and `introspect.ts` (detail/tools/test). The
  CLI-config helpers (`loadCliAllow`, `loadCliDescribe`, `readCliSection`) move out
  of `mcp/source.ts` into a dedicated config module with a shared `readConfigFile()`
  primitive (eliminating the 3–5× per-turn file reads). `tools.allow` is either
  enforced (a `.filter()` after `rawTools.map`) or removed with docs updated.
  `invalidateCredentials('tokens')` actually purges tokens (new
  `store.deleteTokens`). **Ensure the credential store is part of the documented
  public surface of `mcp/index.ts`** (it already exports `SqliteCredentialStore` +
  `SecretRef` + `CompositeDispatcher` + OAuth helpers — this is a documentation/
  verification step, not a missing export; closes critique D3). All production files
  import via `mcp/index.ts` not internals. The section comments that referenced TUI
  are updated to name the `/admin/connectors` routes.

**Resolves:** Z08-01, Z08-02, Z08-05, Z08-07, Z08-08, Z08-10, Z08-14, Z08-18,
Z08-19
**Zones touched:** Z08 · **Depends on:** C10 (the dispatcher dead-code is already
removed), C11 (the SSRF guard lands in the same subsystem first) ·
**Effort:** L · **Blast radius:** package
_(`Z08-01` tools.allow-not-enforced and `Z08-05` token-invalidation no-op are the
two with runtime/security bite. The MCP-supplement findings (Z08-21..30) are
handled separately in C31–C34 so this chunk's diff stays focused on the split.)_

### C17 — Relocate domain types to `@sym/contracts` and trim its surface

**Goal:** domain types live where they belong. Move `OwnerIdentity` from
`kernel/prompt.ts` to `contracts/domain.ts`; move `ReceiptFooterField` from
`contracts/slack.ts` to `contracts/domain.ts`. Remove the dead provider-
abstraction types (`ProviderInterface`, `CompletionRequest`, `CompletionChunk`,
`FinishReason`, `ToolCallDelta`); rename `provider.ts` → `chat.ts` (keeping
`ChatRole`/`ChatMessage`/`Usage`). Fix `ToolSuccess.content` to `JsonValue`
(drop redundant `| string`); export `SymErrorBase`; document the `JsonSchema`
index-signature constraint; drop legacy `main`/`types` package.json fields.
Broaden `buildTurnContextPrompt` visibility so `slash_command` is treated as
PRIVATE (a privacy-guard correctness fix). Expand the type-level test coverage.

**Resolves:** Z10-01, Z10-03, Z10-04, Z10-05, Z10-06, Z10-07, Z10-08, Z10-11,
Z11-02, Z11-03
**Zones touched:** Z10, Z11 · **Depends on:** C04 (clean `dist/`), C10 (the dead
provider types are confirmed unused) · **Effort:** M ·
**Blast radius:** ⚠ cross-unit
_(**Run the cross-unit-impact checklist.** `OwnerIdentity` is imported by
`handle-turn.ts`, `owner-gate.ts`, `workspace-context.ts`, `pi/loop.ts`; the
provider-type removal and `content` retype touch every contracts consumer. Update
all in the same change.)_

### C18 — Fix multi-turn history fidelity (tool-result `isError`, tool-call blocks)

**Goal:** the model sees accurate multi-turn context. Add `isError?: boolean` to
`ChatMessage` and propagate it through `toAgentMessages` (today hardcoded
`false`, so prior-turn tool failures look like successes). Carry serialized
tool-call content blocks in assistant history (today dropped, causing redundant
tool calls on follow-ups). Document the mention-resolved-text expectation of
`pickThinkingLevel`.

**Resolves:** Z07-02, Z07-03, Z07-15
**Zones touched:** Z07, Z10 (contracts) · **Depends on:** C17 (extends
`ChatMessage` in contracts) · **Effort:** M · **Blast radius:** ⚠ cross-unit
*(**Run the cross-unit-impact checklist** — it changes the `ChatMessage` contract.
Separated from C17 because it is a *behavioral* fidelity fix, not a pure type
move; it benefits from C15's `toAgentMessages` tests landing first.)*

### C19 — Naming, surface-hygiene & remaining test-seam polish

**Goal:** the per-module polish that makes each file read as hand-crafted: rename
`thinking-copy.ts` → `shimmer-phrases.ts`; mark internal pipeline functions as
test-only (`_parseRemovals`, etc.); remove pointless `useCallback` wrappers and
fragile module-level singletons (parameterize `loadStarterPrompts`); extract the
duplicated `assistantThread*` and `stripLeadingMention` helpers in the adapter;
consolidate `StepContentProps` refs and fix `SummaryLine` (the `tui/` is kept —
C03 — so these TUI polish items are in scope); add the missing
`injectValueTemplate` Step-union member; add module-doc comments; memoize the
`cleanupReply` model; add the `cleanupReply` real-wire canary test.

**Resolves:** Z05-04, Z05-10, Z05-11, Z05-12, Z05-15, Z09-04, Z09-05, Z09-09,
Z09-10, Z09-11, Z09-12, Z09-17, Z11-06, Z11-08, Z11-09, Z11-10, Z11-11, Z11-12,
Z12-03, Z12-04, Z12-06, Z12-08, Z12-09, Z12-12, Z12-13
**Zones touched:** Z05, Z09, Z11, Z12 · **Depends on:** C12 (adapter split
done), C03 (TUI is kept — its polish is in scope), C14 + **C15** (the
`thinking-copy` rename must follow C15 populating the file — closes critique D1) ·
**Effort:** M · **Blast radius:** package
_(Pure polish — each item is independently revertable. The `kernel` prompt-section
extraction (Z11-08) and its tests (Z11-06/09) make `buildSystemPrompt`'s 13
sections individually grep-able.)_

---

## Band D — Security, observability & performance hardening (the gap-fill)

These chunks close the cross-cutting concerns the original per-file partition
structurally missed (critique M1–M5) and the gap-fill zones Z15/Z16/Z08-supplement
surfaced. They are placed after the structural splits so they target the files in
their final shape, but the **pure-test** chunk C26 and the **small production
fixes** C27–C34 have no structural dependency and may be pulled earlier if
convenient.

### C26 — Adversarial tests for the `POST /slack/interactivity` trust chain

**Goal:** the owner-gated destructive-tool authorization chain has adversarial
test coverage. Add a `describe('agent server /slack/interactivity')` block to
`tests/server.test.ts` with six scenarios: (1) missing signature → 401, (2)
non-owner click → 200 silent ACK, (3) foreign workspace → 200 silent, (4) invalid
`action_id` format → 200 ACK with no resolution, (5) unknown/stale UUID →
`resolveConfirmation` returns `false`, (6) post-timeout approval → confirmation
already `false` from the timeout. **Pure test addition — no source change.** This
is the highest-value missing review in the audit: the path where a Slack button
click authorizes a `post`/`delete`/`run_cli` call.

**Resolves:** Z15-08
**Zones touched:** Z15, Z04 (server) · **Depends on:** C08 (unit/integration
split so these fast tests land in the unit suite) · **Effort:** M ·
**Blast radius:** isolated
_(Z15-08 is `high`. No live Slack endpoint required — the handler is driven via
`app.request()` with signed/forged bodies.)_

### C27 — Credential store hardening (file permissions, key hint, replay logging)

**Goal:** the encrypted SQLite credential tier is defense-in-depth correct and
observable. Three small production changes: (1) `mcp/store.ts:164` —
`mkdirSync(..., { mode: 0o700 })` and best-effort `chmodSync(dbPath, 0o600)` after
open (the DB file is currently world-readable; connector names are plaintext
columns). (2) `store.ts:105` — replace the broken CJS `require('crypto')`
key-generation hint (fails in this pure-ESM project) with `openssl rand -base64
32`. (3) `server.ts:468` — check the `resolveConfirmation` return value and
`console.warn` on `false` (a replayed/post-timeout button click is currently
invisible to the operator).

**Resolves:** Z15-04, Z15-05, Z15-07
**Zones touched:** Z15, Z08 (store), Z04 (server) · **Depends on:** — ·
**Effort:** S · **Blast radius:** isolated
_(Z15-04 is `medium`. This complements — does not replace — the AES-256-GCM
encryption already on the blob values. Independent of the file splits.)_

### C28 — Guard observability & owner-gate documentation

**Goal:** the security-sensitive control points document their contracts and
surface their fail-open/promote decisions in logs (no behavior change). (1)
`pi/loop.ts` — add a comment at the `judgeSlackToolUse` call site explaining the
slack-guard fail-open, and a `console.warn` when the `'confirm'` verdict has no
channel context and silently promotes to `'allow'` (currently a privacy-sensitive
read is unblocked with no log line). (2) `slack-guard.ts` — comment
`SLACK_GUARD_TOOLS` noting that omitting a tool bypasses the guard. (3)
`assistant.ts` — add a JSDoc `CALLER MUST owner-gate before invoking` to
`handleAssistantThreadStarted` (it makes three Slack calls on behalf of the
opening user with no internal gate).

**Resolves:** Z15-01, Z15-02, Z15-03
**Zones touched:** Z15, Z07 (loop), Z04 (assistant) · **Depends on:** — ·
**Effort:** S · **Blast radius:** isolated
_(Z15-02 — the `'confirm'`→`'allow'` silent promotion on the no-channel path — is
the one with privacy bite on the `response_url` flow.)_

### C29 — Admin loopback guard negative test

**Goal:** the `/admin/*` 403 path is exercised. Add a unit test (in
`tests/server.test.ts` or a new `tests/admin.loopback.test.ts`) that calls
`app.request()` for `GET /admin/status` with a mocked `ConnInfo` remote address of
`1.2.3.4` and asserts status `403`. Today all five admin routes guard with
`isLoopback()` but every existing test runs on a real loopback socket, so the
negative path has zero coverage.

**Resolves:** Z15-06
**Zones touched:** Z15, Z04 (server) · **Depends on:** C08 · **Effort:** S ·
**Blast radius:** isolated

### C30 — `url_verification` challenge cap + Block Kit type-tightening

**Goal:** (1) `server.ts:356` — cap the echoed `url_verification` challenge at 512
chars (`parsed.challenge.slice(0, 512)`); the request is HMAC-signed so this is
defense-in-depth, but an unbounded echo is never necessary. (2)
`confirmations.ts:200-223` — replace the `unknown[]` blocks parameter/return type
in `buildResolvedConfirmationMessage` with the `SlackBlock` union from
`@sym/adapter-slack`, eliminating the `(b as { type?: string })` cast.

**Resolves:** Z15-09, Z15-10
**Zones touched:** Z15, Z04 (server/confirmations) · **Depends on:** C12 (the
`SlackBlock` surface is finalized in the consolidated adapter) · **Effort:** S ·
**Blast radius:** isolated

### C31 — MCP fixes: dead `listAsync`, `ensureEntry` client leak, NaN connect timeout

**Goal:** three correctness fixes in the MCP dispatcher. (1) Remove the dead
`McpDispatcher.listAsync()` (`dispatcher.ts:304`) — it is not part of the
`ToolDispatcher` contract and has zero callers; the real async warm-up is
`initMcpPool()`. (2) `ensureEntry` (`dispatcher.ts:282`) closes the stale failed-
OAuth dummy client before `pool.set` (matching `reconcileConnectors` and
`testConnector`, which already do). (3) `SYM_MCP_CONNECT_TIMEOUT_MS`
(`dispatcher.ts:53`) gets explicit `Number.isFinite` validation — a non-numeric
value currently becomes `NaN`, which `setTimeout` treats as `0`, silently
disabling the connect timeout for all connectors.

**Resolves:** Z08-21, Z08-22, Z08-26
**Zones touched:** Z08-supplement · **Depends on:** C16 (the dispatcher is in its
final split shape) · **Effort:** S · **Blast radius:** isolated
_(All three are `high`/`medium`. Z08-21 and Z08-26 are the ones a future
contributor would otherwise trip over — a phantom warm-up method and a silently
disabled timeout.)_

### C32 — MCP `StaticProvider` connector name + temp-dir cleanup contract

**Goal:** the file-injection provider names its temp dirs correctly and its
cleanup lifetime is explicit. (1) `StaticProvider.materialize()`
(`providers/static.ts:120`) passes the actual connector name (threaded from
`MakeProviderDeps.connectorName`) instead of the hardcoded `'connector'` prefix.
(2) The discarded `_cleanup` (`static.ts:118`) is resolved: either propagate
`cleanup()` through `ResolvedCredential`/`buildTransport` and call it after
`client.connect()` succeeds, **or** drop it from the destructure and add a comment
that the temp dir is reclaimed by the `materialize.ts` `_activeDirs` exit handler
(naming the intent either way).

**Resolves:** Z08-23, Z08-24, Z08-30
**Zones touched:** Z08-supplement · **Depends on:** C16 · **Effort:** S ·
**Blast radius:** isolated
_(Z08-24 is the slow RAM leak on `/dev/shm` for long-running processes with
rotating credentials — worth resolving rather than only documenting.)_

### C33 — MCP `ResolvedCredential` native-variant type-safety

**Goal:** the `apply:'native'` variant types `oauth` as `OAuthClientProvider`
(imported from `@modelcontextprotocol/sdk/client/auth.js`) instead of `unknown`,
eliminating the `as OAuthClientProvider` cast in `inject.ts:181`.

**Resolves:** Z08-25
**Zones touched:** Z08-supplement · **Depends on:** C16 · **Effort:** S ·
**Blast radius:** isolated

### C34 — MCP OAuth localhost warning + signal-handler simplification + composite seam

**Goal:** deployers who forget `SYM_PUBLIC_URL` get a signal, and two small
structure clean-ups land. (1) `providers/oauth.ts:270` — `console.warn` when the
`http://localhost:3000` redirect-URI fallback is used (naming `SYM_PUBLIC_URL`);
absent, OAuth connectors register localhost in production and hang in pending-auth
with no log evidence. (2) `materialize.ts:163` — replace the `makeSignalHandler`
factory (called once per signal, no parameterization) with a single named
`handleSignal`. (3) `composite.ts` — either inline the 41-line pass-through
`CompositeDispatcher` as a `buildDispatcher` helper in `handle-turn.ts` or keep it
with a comment clarifying the routing-vs-execution seam.

**Resolves:** Z08-27, Z08-28, Z08-29
**Zones touched:** Z08-supplement · **Depends on:** C16 (composite/dispatcher in
final shape) · **Effort:** S · **Blast radius:** isolated
_(Z08-29 — the silent localhost OAuth fallback — is the production-bite item.)_

### C35 — Logging hygiene gate + per-turn correlation id

**Goal:** the documented anti-flake rule becomes machine-enforced and concurrent
turns become distinguishable in logs. (1) Add a ~30-second **CI grep-gate** that
fails if any `.ts`/`.tsx` file outside `apps/agent/src/cli/` contains an
executable `console.log` — this permanently prevents the regression that bit CI
twice (server `console.log` racing into the CLI tests' `JSON.parse` of `--json`
output). **There are ZERO executable `console.log` outside `cli/` today** (the
critique's "two violations" were a comment + a help string — false positives), so
this is a _gate_, not a fix. (2) Thread `turn.id` as a prefix on every server-path
log call inside `handleTurn`/`streamReply`/`runTurnLoop`/`runLoopPi` via a small
`logCtx(turnId)` helper. (3) Codify the `error`/`warn`/`info` convention in
ARCHITECTURE.md (lands with C22).

**Resolves:** Z16-01, Z16-02, Z16-03
**Zones touched:** Z16, Z04, Z07, (CI config) · **Depends on:** C07 (CI lint
scaffold exists) · **Effort:** S–M · **Blast radius:** package
_(Z16-02 correlation-id is the substantive item; the grep-gate is trivial but
high-value. Explicitly **no "fix two console.log" task** — there is nothing to
fix, only a gate to add.)_

### C36 — Hot-path performance: bound the loop, bound the context, document the budget

**Goal:** the per-turn cost/latency profile has a ceiling and a written budget.
(1) Pass `AbortSignal.timeout(60_000)` into `runLoopPi` as the external signal —
the abort path already surfaces a graceful reply (`loop.ts:706`), but `runLoopPi`
sets no deadline today, so a stuck model or Fireworks error loop consumes credits
without bound. (2) Add a `limit` (default 80, `SYM_THREAD_HISTORY_LIMIT`) to the
`conversationsReplies` threaded-history call (`handle-turn.ts:522`) — today the
`HISTORY_LIMIT=20` cap applies only to the un-threaded path, so a 200-reply thread
sends all 200 messages every turn. (3) Consider skipping `cleanupReply` in buffer
mode when the draft is short (narration never appeared on screen). (4) Add a
**"Per-turn latency & cost budget"** section to ARCHITECTURE.md with three tiers
(simple / single-tool / multi-tool) and roll the scattered micro-findings (Z03-10,
Z07-10, Z08-08, Z06-14, Z05-15) under it as line items.

**Resolves:** Z16-04, Z16-05, Z16-06, Z16-07
**Zones touched:** Z16, Z04, Z07 · **Depends on:** C14 + C15 (the hot-path files
are in final shape), C22 (the budget section is written into ARCHITECTURE.md) ·
**Effort:** M · **Blast radius:** package
*(Z16-04 unbounded loop and Z16-05 unbounded thread context are the two with real
cost bite on a busy thread. The micro-findings (Z03-10/Z07-10/Z08-08/Z06-14/
Z05-15) are *referenced* here for framing but are **resolved in C06/C13/C15/C16/
C19** respectively — they are not double-counted; this chunk owns only the four
Z16 findings.)*

### C37 — TUI accessibility (NO_COLOR, isTTY guard, ASCII fallback)

**Goal:** the kept Ink/React operator TUI degrades correctly in CI / non-TTY /
ANSI-hostile environments. (1) In `tui/index.tsx` `launchTui`, shim
`NO_COLOR` → `FORCE_COLOR=0` before `render()` (Chalk 5's vendored
`supports-color` does not honor `NO_COLOR`; today `NO_COLOR=1` has no effect).
(2) Add the `isTTY` guard to the `sym menu` / `sym tui` subcommands
(`cli/index.ts:627`) that the bare `sym` path already has — `sym menu | head`
currently attempts Ink rendering in a non-TTY context. (3) Optionally thread an
`ascii` flag into `healthGlyph` (`tui/ui/theme.ts`) rendering `+`/`-`/`!` for
`TERM=dumb`. Document `NO_COLOR` support in the README.

**Resolves:** Z16-11, Z16-12, Z16-13
**Zones touched:** Z16, Z09 (tui/cli) · **Depends on:** C03 (the TUI is kept),
C19 (TUI files in final shape) · **Effort:** S · **Blast radius:** isolated
_(Real OSS-quality gap now that C03 keeps the TUI. Z16-11 `NO_COLOR` is the
standards-compliance item; Z16-12 isTTY is the DX correctness item.)_

---

## Band E — Documentation & OSS-readiness

Last, because they describe the now-final structure. These are launch-blockers by
their **absence**.

### C20 — Overhaul the README to match the real repo and stand up a working bot

**Goal:** a newcomer who follows the README gets a working bot. The "Repository
layout" section lists every top-level directory; the env-var table covers all
≥15 vars grouped by concern (with a link to `docs/reference/env-vars.md`); the
Slack setup section **points to `pnpm manifest:render` as the single source of
truth** and states explicitly that `slack/manifest.template.yml` is **already
correct** (`im:read`, `commands`, `assistant:write`, `assistant_thread_*` at
lines 64/88/90/124-125). The **wrong scopes are in `README.md:45` only**
(`im:write`, missing `commands`/`assistant:write`) — fix that prose block by
replacing it with the `manifest:render` pointer, not by hand-editing scope lists.
The "How it works" section covers slash commands, the assistant panel, MCP
connectors, **and the local-state control tier (operator TUI/CLI + encrypted
credential store)**; the license line and badges are fixed; a Docker run option
is added. `turbo dev` gets `dependsOn: ['^build']`; the DOM-lib/composite/vitest
config comments are added.

**Resolves:** Z01-01, Z01-03, Z01-04, Z01-05, Z01-14, Z01-15, Z03-06, Z03-11,
Z03-12, Z14-01, Z14-03, Z14-07, Z14-17, Z14-18, Z14-19, Z14-20, Z14-26, Z14-28,
Z14-31
**Zones touched:** Z01, Z03, Z14 · **Depends on:** C02 (env-var docs exist), C03
(the control-tier framing the README now describes), C12 + C13 + C16 (the
structure the README describes is final) · **Effort:** M ·
**Blast radius:** isolated
_(The wrong Slack scopes are `high`: they are the difference between a contributor
getting a working bot and not. Precision matters — the manifest template is
already right; only README prose is wrong.)_

### C21 — Add the OSS community-health baseline + supply-chain hygiene

**Goal:** GitHub's community-standards floor is met, a first contributor has
orientation, and the runtime dependency tree is scanned. Create `CONTRIBUTING.md`
(prerequisites, dev loop, Conventional Commits, "Discussion before feature PRs"),
`SECURITY.md` (Private Vulnerability Reporting + the real threat surface: token
leakage, SSRF, prompt injection, the interactivity→confirmation→destructive-tool
chain), `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), `.github/ISSUE_TEMPLATE/`
(bug + feature YAML forms), `.github/CODEOWNERS`, and pin GitHub Actions to SHAs.
**`.github/dependabot.yml` covers BOTH `npm` (all pnpm workspaces, weekly) AND
`github-actions` (weekly)** — the original Actions-only scope left the npm tree
(`ink`, `hono`, MCP SDK, `pi-ai`) unscanned (Z16-08). Add `pnpm audit
--audit-level=high` as a CI step. Generate **`THIRD-PARTY-LICENSES.md`** via
`pnpm licenses list` (all runtime deps are MIT/ISC — confirmed — so no NOTICE is
legally required, but attribution is good practice for Docker/bundled
redistribution, Z16-10). Note SBOM as **deferred to the OSS launch tag** (Z16-09).
Add real author name(s) to `LICENSE`. Add a CI guard blocking a committed rendered
Slack manifest — **note: no rendered manifest is tracked today** (`git ls-files
slack/` returns only `README.md` + `manifest.template.yml`), so this is a
_preventive_ guard, not a `git rm` (Z03-07 reframed).

**Resolves:** Z02-18, Z02-20, Z14-08, Z14-22, Z14-24, Z14-25, Z14-27, Z03-07,
Z16-08, Z16-09, Z16-10
**Zones touched:** Z02, Z14, Z03, Z16 · **Depends on:** C20 (so docs cross-link
consistently) · **Effort:** M · **Blast radius:** isolated
_(R2 P0. The `Z03-07` "rendered manifest committed" framing was **false against
HEAD** — corrected to a preventive CI guard. The supply-chain items Z16-08/09/10
fold in here because they are community-health/dependabot work.)_

### C22 — Write ARCHITECTURE.md (with the two-tier model + perf budget), CHANGELOG.md, and fix the cross-unit-impact skill

**Goal:** the non-obvious four-package layering and design invariants are written
down (matklad/rust-analyzer codemap format: bird's-eye view, per-module table,
explicit invariants). The invariants section **explicitly documents the two-tier
architecture**: (a) the _conversational tier_ is stateless — no message DB, the
Slack thread is the memory; (b) the _control tier_ is intentional local state —
the operator TUI/CLI and the encrypted SQLite credential store. Other invariants:
kernel has no Slack dep, `handle-turn` is the sole Pi-loop entry, the MCP
dispatcher is the sole external-tool integration point, every privileged entry
point is owner-gated. Add the **log-level convention** (error/warn/info — for
C35) and the **per-turn latency & cost budget** section (for C36). A `CHANGELOG.md`
(Keep a Changelog) starts with `[Unreleased]` + a retrospective 2026-05-27
collapse entry, wired to git-cliff/changesets. The `cross-unit-impact` SKILL.md is
updated from the removed two-service/Postgres framing to the current
single-service architecture (keeping the expand-contract core).

**Resolves:** Z14-09, Z14-23, Z14-30, Z02-05
**Zones touched:** Z14, Z02 · **Depends on:** C20, C03 (the two-tier model),
C12 + C13 + C14 + C16 (the architecture must be final before it is documented) ·
**Effort:** M · **Blast radius:** isolated
_(R2 P1. `Z02-05` — the PR-template internal-jargon sections — is finished here by
introducing the lean external template alongside a `maintainer.md` variant. C35's
log-level convention and C36's perf budget are authored into this doc.)_

### C23 — Fix test-suite quality, flakiness, and naming

**Goal:** the test suite is reliable and consistent. Replace the
`vi.spyOn(console,'log')`-in-process pattern in `cli.commands.test.ts` with
subprocess stdout capture (the race that bit CI twice). Replace `setTimeout(r,0)`
and wall-clock `tick()` helpers with `vi.waitFor`. Fix the `mcp.test.ts` vi-hoist
comment, add `mcp/source` direct tests, `think-router` boundary tests, the
`pi-loop` Reply-construction test, the `manifest-prompts` path guard, the
`admin.reload` error-path cases, and the `search_messages` happy-path behavior
assertion. Rename `cli.admin-client.test.ts` → `admin.client.test.ts`.

**Resolves:** Z13-04, Z13-08, Z13-12, Z13-13, Z13-14, Z13-16, Z13-17, Z13-18,
Z13-19, Z13-20, Z13-21
**Zones touched:** Z13 · **Depends on:** C08, C09, C13–C16 (the modules these
tests target are in final shape) · **Effort:** M · **Blast radius:** isolated
_(The TUI `tick()` flakiness fixes (Z13-14) apply to the **kept** TUI test files —
they are hardened, not deleted, under the C03 reframe.)_

### C24 — Apply Diátaxis docs structure and promote the quality gates to error

**Goal:** the docs read as a maintained OSS project and the quality bar becomes
enforced rather than advisory. Structure `docs/` into `tutorials/` / `how-to/` /
`reference/` / `explanation/` (move the env table to `reference/env-vars.md`).
Clean the `mcp-setup.md` internal notation. Promote the R3 size/complexity ESLint
rules (and `no-explicit-any` repo-wide) from `warn` to `error` now that the
oversized files are split. Optionally add `jscpd` + Biome cognitive-complexity as
CI gates.

**Resolves:** Z14-10
**Zones touched:** Z14, (CI config) · **Depends on:** C13 + C14 + C15 + C16 (all
files must be under the size limit before the gate becomes `error`), C07 (the
rules exist at `warn`) · **Effort:** M · **Blast radius:** isolated
_(R2 P2, R3 summary. This is the chunk that makes the cleanup permanent: after it,
a regression to a 1000-line file fails CI.)_

### C25 — Add an `examples/` directory

**Goal:** OSS users have copy-pasteable starting points for the primary extension
point. Create `examples/` with a sample MCP connector `config.json` for two
common connectors (e.g. sentry + gcloud), an annotated `.env` walkthrough, and a
minimal-vs-full setup comparison. Link from the README and `docs/mcp-setup.md`.

**Resolves:** Z14-34
**Zones touched:** Z14 · **Depends on:** C02 (env vars documented), C16 (MCP
config shape final) · **Effort:** S · **Blast radius:** isolated

---

## Dependency graph (at a glance)

```
Band A (parallel):  C01  C02  C04  C05
                    C03 (legitimize local-state tier — on critical path)
                    C06 ← C03            (ink/react --prod placement)
                    C07 ← C04, C03
Band B:             C08          C09 ← C08, C03
Band C:             C10 ← C07, C03
                    C11
                    C12 ← C04            (⚠ cross-unit)
                    C13 ← C09, C05
                    C14 ← C09, C12
                    C15 ← C05, C09
                    C16 ← C10, C11
                    C17 ← C04, C10       (⚠ cross-unit)
                    C18 ← C17            (⚠ cross-unit)
                    C19 ← C12, C03, C14, C15      (C15 edge closes critique D1)
Band D:             C26 ← C08            (interactivity adversarial tests)
                    C27                  (credential store hardening)
                    C28                  (guard observability)
                    C29 ← C08
                    C30 ← C12
                    C31 ← C16   C32 ← C16   C33 ← C16   C34 ← C16
                    C35 ← C07            (console.log gate + correlation id)
                    C36 ← C14, C15, C22  (hot-path perf + budget)
                    C37 ← C03, C19       (TUI accessibility)
Band E:             C20 ← C02, C03, C12, C13, C16
                    C21 ← C20
                    C22 ← C20, C03, C12, C13, C14, C16
                    C23 ← C08, C09, C13, C14, C15, C16
                    C24 ← C07, C13, C14, C15, C16
                    C25 ← C02, C16
```

**Critical path:** **C03** → C04 → C07 → C10 → C16 → C20 → C22. C03 is now an
explicit gating predecessor (it was missing from the old diagram — critique D2);
with the keep-decision locked its effort firms to S–M, so the gate no longer
carries unbounded latency. The structural file-splits (C13/C14/C15) parallelize
against each other once their Band-B test prerequisites (C08/C09) land. The
MCP-supplement chunks (C31–C34) all fan out from C16 and parallelize. The three
⚠ cross-unit chunks (C12, C17, C18) most need the discipline of the
[`cross-unit-impact`](../../.claude/skills/cross-unit-impact/SKILL.md) checklist —
do not batch them with unrelated work.

## Coverage guarantee

All **288 findings** across the **17 zones** (14 original Z01–Z14 + the three
gap-fill zones Z15 security, Z16 cross-cutting, Z08-supplement) are assigned to
exactly one of these **37 chunks** — none dropped, none double-counted. This was
re-reconciled after the corrective pass:

| Source              | Findings | Notes                                                                                                         |
| ------------------- | -------: | ------------------------------------------------------------------------------------------------------------- |
| Z01–Z14 (original)  |      255 | the true count; the old docs said **252** by miscounting Z05 (17, incl. Z05-16/17) and Z12 (14, incl. Z12-14) |
| Z15 (security)      |       10 | new gap-fill zone                                                                                             |
| Z16 (cross-cutting) |       13 | new gap-fill zone                                                                                             |
| Z08-supplement      |       10 | new gap-fill review (IDs Z08-21…Z08-30)                                                                       |
| **Total**           |  **288** |                                                                                                               |

The three findings the old backlog **dropped on the floor** are now assigned:
**Z05-16** (confusing `RepliesResponse` reuse, `slack-client.ts:247`) → **C12**;
**Z05-17** (unnecessary non-null assertion, `web-search.ts:43`) → **C10**;
**Z12-14** (Slack-client `RepliesResponse` concern flagged "for Z05") → **C12**.
After this every zone finding maps to exactly one chunk.

To trace any finding to its chunk, grep this file for the finding ID (e.g.
`Z08-17` or `Z15-08`); to trace any chunk back to evidence, open the zone report
named in its "Zones touched" line.
