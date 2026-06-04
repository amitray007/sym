# Zone Map — disjoint ownership partition

The audit divided the repo into **17 zones** (14 original + 3 corrective-pass),
each owning a non-overlapping slice of files. This partition served two purposes:
it let reviewers work in parallel without stepping on each other, and it
**doubles as the parallel-execution plan for the refactor** — zones that own
disjoint files can be worked simultaneously by separate agents/contributors.

> **Corrected 2026-06-02.** The first draft claimed a clean 14-zone partition of
> "252 findings." A completeness critique found the partition had holes: three
> live source files (`confirmations.ts`, `slack-guard.ts`, `assistant.ts`) were
> owned by **no** zone, and several MCP files were named only in passing.
> Per-zone counts were also off (Z05 is 17, not 15; Z12 is 14, not 13 — the true
> original total is **255**, not 252). Three corrective-pass zones close the
> holes: **Z15** (security/trust-boundary, picking up the 3 unowned files),
> **Z16** (system-level cross-cutting), and **Z08-supplement** (the unnamed MCP
> files). New grand total: **288 findings**. Coverage is now complete — **no live
> source file is unowned.**

Each zone report (`zones/Znn-*.md`) contains: a summary, a findings table,
per-finding file:line evidence + recommendation + severity + effort + blast
radius, the zone's top risks, and its locally-proposed chunks. Those local
chunks were merged into the global [`BACKLOG.md`](./BACKLOG.md); use the zone
reports for evidence, the backlog for execution order.

---

## The 17 zones

### Original 14 (Z01–Z14)

| Zone    | Title                                     | Owned files (primary)                                                                                                                                                  |     C |      H |      M |       L |   Total | Report                                   |
| ------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | -----: | -----: | ------: | ------: | ---------------------------------------- |
| **Z01** | Repo structure & monorepo packaging       | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `commitlint.config.js`, `.gitignore`, root vitest configs                                   |     0 |      2 |      5 |       8 |      15 | [Z01](./zones/Z01-repo-structure.md)     |
| **Z02** | Tooling: lint, format, hooks, CI          | `eslint.config.js`, `.prettierignore`, `lint-staged.config.js`, `.husky/`, `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `.vscode/`, `.dockerignore` |     0 |      5 |      7 |       8 |      20 | [Z02](./zones/Z02-tooling-ci.md)         |
| **Z03** | Build, deploy & runtime infra             | `Dockerfile`, `docker-compose.yml`, `dokploy/`, `scripts/*.sh`, `scripts/render-manifest.js`, `.env.example`, `slack/manifest*.yml`                                    |     2 |      6 |      6 |       5 |      19 | [Z03](./zones/Z03-build-deploy.md)       |
| **Z04** | Core agent — entry & orchestration        | `apps/agent/src/handle-turn.ts`, `server.ts`, `config.ts`, `workspace-context.ts`, `owner-gate.ts`, `assistant-context.ts`, `plan-controller.ts`                       |     0 |      3 |      6 |       8 |      17 | [Z04](./zones/Z04-core-orchestration.md) |
| **Z05** | Slack I/O & text processing (app layer)   | `apps/agent/src/slack-client.ts`, `name-resolver.ts`, `reply-cleanup.ts`, `safe-fetch.ts`, `web-search.ts`, `thinking-copy.ts`, `manifest-prompts.ts`                  |     0 |      2 |      7 |       8 |      17 | [Z05](./zones/Z05-slack-io-text.md)      |
| **Z06** | builtin-tools.ts (the 1679-line monolith) | `apps/agent/src/builtin-tools.ts`, `run-cli.ts`, `tests/builtin-tools.test.ts`                                                                                         |     0 |      4 |      6 |       7 |      17 | [Z06](./zones/Z06-builtin-tools.md)      |
| **Z07** | Pi agent loop                             | `apps/agent/src/pi/loop.ts`, `tools.ts`, `meta-tools.ts`, `model.ts`, `think-router.ts`                                                                                |     0 |      2 |      6 |       9 |      17 | [Z07](./zones/Z07-pi-loop.md)            |
| **Z08** | MCP client subsystem                      | `apps/agent/src/mcp/*` (config, dispatcher, source, store, inject, composite, materialize, oauth-registry, providers/)                                                 |     0 |      3 |      7 |      10 |      20 | [Z08](./zones/Z08-mcp-client.md)         |
| **Z09** | TUI & CLI (local-state control tier)      | `apps/agent/src/tui/*`, `apps/agent/src/cli/*`                                                                                                                         |     1 |      6 |      6 |       7 |      20 | [Z09](./zones/Z09-tui-cli.md)            |
| **Z10** | packages/contracts (shared types)         | `packages/contracts/src/*`, `tests/contracts.test-d.ts`, `packages/contracts/dist/*`                                                                                   |     0 |      2 |      5 |       4 |      11 | [Z10](./zones/Z10-contracts.md)          |
| **Z11** | packages/kernel                           | `packages/kernel/src/*` (prompt, receipt, tools), `tests/`, `packages/kernel/dist/*`                                                                                   |     0 |      2 |      4 |       7 |      13 | [Z11](./zones/Z11-kernel.md)             |
| **Z12** | packages/adapter/slack                    | `packages/adapter/slack/src/*` (client, types, normalize, blocks, render, thread, receipt, verify), `dist/*`                                                           |     0 |      1 |      4 |       9 |      14 | [Z12](./zones/Z12-adapter-slack.md)      |
| **Z13** | Tests & QA strategy                       | all `tests/` dirs across packages, all `vitest.config.ts`, CI test invocation                                                                                          |     1 |      5 |      9 |       6 |      21 | [Z13](./zones/Z13-tests-qa.md)           |
| **Z14** | Documentation & OSS readiness             | `README.md`, `docs/FUTURE.md`, `docs/mcp-setup.md`, `slack/README.md`, `dokploy/README.md`, community-health files, `.github/` templates                               |     0 |      9 |      8 |      17 |      34 | [Z14](./zones/Z14-docs-oss.md)           |
|         | **Original subtotal**                     |                                                                                                                                                                        | **4** | **52** | **86** | **113** | **255** |                                          |

### Corrective-pass zones (Z15, Z16, Z08-supplement)

| Zone      | Title                                       | Owned files (primary)                                                                                                                                          |     C |      H |      M |       L |   Total | Report                              |
| --------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | -----: | -----: | ------: | ------: | ----------------------------------- |
| **Z15**   | End-to-end security & trust-boundary review | `apps/agent/src/confirmations.ts`, `slack-guard.ts`, `assistant.ts`, the `POST /slack/interactivity` + `/admin/*` flows in `server.ts`, `mcp/store.ts` (perms) |     0 |      1 |      2 |       7 |      10 | [Z15](./zones/Z15-security.md)      |
| **Z16**   | System-level cross-cutting concerns         | logging/observability, hot-path performance, supply-chain, TUI accessibility — across `handle-turn.ts`, `pi/loop.ts`, `server.ts`, `tui/`, `.github/`          |     0 |      0 |      4 |       9 |      13 | [Z16](./zones/Z16-cross-cutting.md) |
| **Z08-s** | MCP subsystem (supplement)                  | `mcp/dispatcher.ts`, `composite.ts`, `materialize.ts`, `providers/static.ts`, `providers/oauth.ts`, `inject.ts`, `provider.ts`                                 |     0 |      2 |      4 |       4 |      10 | [Z08-s](./zones/Z08-supplement.md)  |
|           | **Gap-fill subtotal**                       |                                                                                                                                                                | **0** |  **3** | **10** |  **20** |  **33** |                                     |
|           | **GRAND TOTAL (17 zones)**                  |                                                                                                                                                                | **4** | **55** | **96** | **133** | **288** |                                     |

`C` = critical, `H` = high, `M` = medium, `L` = low. The original subtotal (255,
not the first draft's 252) reflects the previously-uncounted Z05-16/17 and Z12-14;
the per-row Z05 (now M7/L8) and Z12 (now 14 with L9) cells were re-tallied against
the zone files. **Z13-01 was recast from `critical` to `medium`** (the "delete the
TUI tests" framing is withdrawn now that the control tier is kept — C03), which is
why the critical count is **4**, not 5. The grand total (288) is unchanged by the
reclassification.

---

## Notes on the partition

- **Z04, Z05, Z06, Z07, Z08, Z09** partition `apps/agent/src/` by subsystem so
  the six biggest source areas had dedicated reviewers. The split is by file, not
  by directory: e.g. `slack-client.ts` is Z05's even though it logically belongs
  to the adapter package (that mismatch _is_ finding Z05-01).
- **Z10, Z11, Z12** own one package each, including each package's `dist/`
  (which is where the stale-artifact findings live).
- **Z13 (tests)** and **Z14 (docs)** are cross-cutting by nature — they own the
  `tests/` trees and the documentation surface respectively, across all packages.
  Their findings frequently _reference_ code in other zones but the **owned files**
  (the test files, the markdown) are disjoint from the code zones.
- **Z01, Z02, Z03** partition the root/infra config: Z01 = packaging
  (`turbo.json`, `tsconfig`, `pnpm-workspace`), Z02 = quality tooling
  (`eslint`, CI, hooks), Z03 = build/deploy (`Dockerfile`, `dokploy`, scripts,
  `.env.example`, Slack manifest). `commitlint.config.js` and `.gitignore` Drizzle
  cruft surface in both Z01 and Z02 — the backlog de-dupes these into C01.

### Corrective-pass zones — what they close

- **Z15 (security)** does a dedicated line-by-line pass over the three files the
  original 14-zone partition left **unowned**: `confirmations.ts` (the
  destructive-tool confirm/cancel registry behind `POST /slack/interactivity`),
  `slack-guard.ts` (the fail-open LLM relevance/injection guard), and
  `assistant.ts` (the assistant-panel greeting). It also reviews the four
  privileged entry points (`/slack/events`, `/slack/commands`,
  `/slack/interactivity`, `/admin/*`) as a _trust boundary_, centered on the
  click→confirm→destructive-tool chain. These files are _referenced_ by Z04
  (`server.ts`) and Z07 (`pi/loop.ts`) through their importers, but Z15 is the
  zone that **owns** them.
- **Z16 (cross-cutting)** owns the whole-system properties a per-file partition
  cannot: logging/observability strategy (the `console.log` CI gate + a per-turn
  correlation id), hot-path performance (per-turn abort deadline, bounded thread
  context, a written latency/cost budget), supply-chain (npm dependabot, license
  attribution), and TUI accessibility (`NO_COLOR`, isTTY, ASCII fallback).
- **Z08-supplement** re-reviews the MCP files the original Z08 named only in
  passing — `composite.ts`, `materialize.ts`, `providers/static.ts`,
  `providers/oauth.ts`, `inject.ts`, `provider.ts` — adding 10 findings
  (IDs Z08-21…Z08-30). Its owned-file set overlaps Z08 by design; the two are
  executed together (the supplement findings land in chunks C31–C34, downstream of
  the C16 dispatcher split).

**Coverage is now complete.** Every live source file under `apps/agent/src` and
`packages/*/src` is owned by at least one zone. The earlier partition holes
(3 unowned files, the unnamed MCP files) are closed.

---

## Using zones for parallel execution

When the backlog is executed by multiple agents/contributors in parallel, the
**owned-files column is the conflict-avoidance map**. Two rules:

1. **Same-zone work serializes; cross-zone work parallelizes** — as long as the
   chunks touch disjoint owned-file sets. The backlog's `Zones touched` column
   tells you which zones each chunk reaches.
2. **Cross-zone structural chunks need a single owner.** A few backlog chunks
   deliberately span zones (e.g. C12 "single Slack client" touches Z05 + Z12;
   C13 "split builtin-tools" touches Z06 + Z13). These cannot be parallelized
   internally — assign one owner per cross-zone chunk and let it complete before
   dependent chunks start. The `dependsOn` graph in the backlog encodes this.

The highest-parallelism phase is the **quick-wins band** (C01–C07): config purge
(Z01/Z02/Z03), dead-`dist` cleanup (Z10/Z11/Z12), and env-var docs (Z03/Z14)
touch mostly disjoint files and can run concurrently. The structural band
(C10–C19) is more serialized because the file-extraction chunks depend on the
test-instrumentation chunks (C08/C09) landing first. The **hardening band**
(C26–C37) is highly parallel again — the MCP-supplement fixes (C31–C34) all fan
out from C16, and the security/logging/perf/accessibility chunks touch disjoint
files (Z15 security, Z16 cross-cutting, Z08-supplement).
