# Target Structure — Sym after the refactor

This document records the **end-state** repository structure once the
[`BACKLOG.md`](./BACKLOG.md) chunks have landed. It captures the structural
decisions (which packages survive, where the Slack client lives, how
`builtin-tools.ts` is split, and the **kept-and-legitimized** local-state control
tier) and justifies each against the zone findings and the R1–R3 research.

> **Corrected 2026-06-02.** §5 was previously framed as an _open_ "keep-or-kill"
> decision on the TUI/CLI/secrets tier. **That decision is now made: KEEP
> EVERYTHING.** The operator TUI, the `sym` CLI, the `SecretsManager` screen, and
> the encrypted SQLite credential store are **intended local-state architecture**,
> not slop. §5 is rewritten as "legitimize + document the control tier," and the
> "after" tree (§6) shows it kept (cleaned). The manifest framing in §6 is also
> corrected (U2/U3): no rendered manifest is committed, and the manifest _template_
> is already correct — only the README prose is wrong.

---

## 1. Guiding principles

Four rules, drawn from the (restated) North Star and the research, drive every
decision below:

1. **The repo must not lie about itself.** Every directory, env var, scope, and
   doc claim must match the running code. (R2; the entire Z14 zone.)
2. **A package boundary must earn its keep.** Extract/keep a package only when it
   has ≥2 real consumers _or_ is a deliberate seam for a planned extension.
   Otherwise it is a build step and an import boundary with no payoff. (R1.1–R1.3.)
3. **No file over ~500 lines; no single function holding >1 concern.** File size
   is the most reliable proxy for hidden complexity. (R3.1; the five oversized
   files.)
4. **"Stateless" means the conversational tier only.** There is no message
   database — the Slack thread is the memory. Sym **also** has an intentional
   **local-state control tier** (operator TUI/CLI + encrypted SQLite credentials).
   That tier is first-class architecture to be documented and kept clean, never
   deleted "for statelessness." (Owner decision 2026-06-02.)

---

## 2. Package decisions: contracts / kernel / adapter-slack

The research (R1) is explicit that a single-app monorepo should keep a package
only when it is genuinely shared or a deliberate seam. Applying that test:

| Package                  | Consumers today                                      | Decision              | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@sym/contracts`**     | 3 (`kernel`, `adapter-slack`, `agent`)               | **KEEP**              | Pure types, zero runtime, genuinely multi-consumer — the textbook reason to extract. (R1.2) Add `sideEffects: false`; delete stale `dist/`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`@sym/adapter-slack`** | `agent` only (+ will absorb the second Slack client) | **KEEP**              | It is the **seam between Slack's API and Sym's domain** — the boundary that matters if a second platform is ever added. Keeping it is what makes consolidating the two Slack clients (§3) coherent. (R1.3)                                                                                                                                                                                                                                                                                                                                                                            |
| **`@sym/kernel`**        | `agent` only, exports ~5 functions                   | **KEEP, but tighten** | R1.1 flags it as a collapse candidate (single consumer). The audit recommends **keeping** it — it cleanly isolates prompt-assembly + receipt + the tool-registry null-object, and folding it into the app would re-grow `apps/agent`. But: move the misplaced `OwnerIdentity` domain type out to `contracts` (Z11-02), prune dead exports (Z11-04/05), and **document why the boundary exists** in its `package.json`. The name "kernel" is misleading (it is not the loop) — a rename to `@sym/agent-core` or `@sym/turn-primitives` is noted as optional polish (Z11-11), deferred. |

**Net: all three packages survive.** The contracts/kernel decision is the one
place the audit diverges from the most aggressive research recommendation (R1.1
"collapse kernel") — the justification is that the collapse trades a justified
small package for a larger app file, against principle 3. We keep the boundary
and pay the documentation cost instead.

All three packages get, uniformly: `sideEffects: false`, a clean `dist/` (no
stale artifacts), OSS metadata (`repository`, `author`, `description`), and a
prebuild `clean` step so deleted source can never leave orphaned `.d.ts` behind.
_(Z01-10/11, Z10-02, Z11-01, Z12-01, R1.4.)_

---

## 3. The single Slack client

**Today:** the `SlackClient` interface, retry layer (`withSlackRetries`,
`mapSlackError`), and ~30 param/result types live in
`packages/adapter/slack/src/client.ts` (520 lines) — but the **concrete**
`WebApiSlackClient` HTTP implementation lives in `apps/agent/src/slack-client.ts`
(570 lines), reaching back across the boundary and re-declaring a local
`SlackWebApiError` to bridge the error type. _(Z05-01, Z05-03, Z12.)_

**Target:** the implementation moves into the package it implements, and the
520-line `client.ts` splits along its three responsibilities:

```
packages/adapter/slack/src/
  types.ts            ← all param/result interfaces (was lines 7–331 of client.ts)
  client.ts           ← the SlackClient interface only
  web-api-client.ts   ← WebApiSlackClient (moved from apps/agent/src/slack-client.ts)
  retry.ts            ← SlackApiError, withSlackRetries, mapSlackError, sleep
  normalize.ts        ← (unchanged) inbound event normalization
  blocks.ts           ← (unchanged) Block Kit builders
  render.ts           ← (unchanged) render-intent pipeline
  thread.ts           ← (unchanged) thread fetch
  receipt.ts          ← (unchanged) receipt → Slack footer
  verify.ts           ← (unchanged) signature verification
  index.ts            ← public surface (excludes internal mapSlackError)
```

`apps/agent/src/slack-client.ts` is **deleted**; `workspace-context.ts` imports
`WebApiSlackClient` from `@sym/adapter-slack`. This completes the adapter
boundary (a second app could now reuse it), eliminates the `SlackWebApiError`
duplication, and lets the empty-string branded-id casts get fixed in one place.
_(Backlog C12, citing Z05-01/02/03/06, Z12-02/05.)_

The three `NameResolver.isUserId/isChannelId/isDmId` **static predicates** also
move out — they are pure domain knowledge with no instance state — to standalone
`isSlackUserId` / `isSlackChannelId` / `isSlackDmId` functions exported from the
adapter package. _(Z05-05.)_

---

## 4. How `builtin-tools.ts` (1679 lines) is split

The single largest structural violation. The R3 research, oclif, and rushstack
all converge on the **one-file-per-tool registry** pattern. Target:

```
apps/agent/src/tools/
  index.ts          ← re-exports createBuiltinDispatcher() only
  registry.ts       ← ALL_BUILTIN_DESCRIPTORS, DESCRIPTORS_BY_NAME, dispatch table
  _helpers.ts       ← argError, execError, errMsg, clampedLimit, coercePairs, fieldsFor
  slack-read.ts     ← read_channel, read_thread, read_user_profile, search_messages, list_channels
  slack-write.ts    ← post_as_owner, react_as_owner, set_status, add_reminder, delete_message
  web.ts            ← fetch_url, web_search
  exec.ts           ← run_cli
  plan.ts           ← set_plan, update_task
  ui.ts             ← present_card, present_table
  meta.ts           ← get_current_time
```

The 866-line `dispatch` if/else chain becomes a `Map<string, ToolHandler>`
lookup (~10 lines) that reuses the already-built `DESCRIPTORS_BY_NAME` map. The
26× `invalid_arguments` boilerplate, 11× error-extraction ternary, and 18× cast
boilerplate collapse into the `_helpers.ts` primitives. `builtin-tools.ts`
becomes a thin wiring file (~50 lines) that re-exports from `tools/`. Each tool
becomes independently unit-testable at `tests/tools/<name>.test.ts`.
_(Backlog C13, citing Z06-01/02/03/04/06/07/08/09/10/11/12/13/14/15/16/17.)_

The other oversized files decompose along the same "one concern per module"
principle (backlog C14–C18):

- `handle-turn.ts` (1057) → `task-card-manager.ts` + `turn-context.ts` +
  `stream-reply.ts`, leaving `handle-turn.ts` as the orchestrator only.
- `server.ts` (804) → extract `event-router.ts` (the two 100-line closures) and a
  single `verifySlack` middleware (replacing the 3× copy-paste).
- `pi/loop.ts` (734) → extract `buildAgentTools`, `buildAgentSystemPrompt`,
  `makeBeforeToolCall`, `makeSubscriber` helpers; `runLoopPi` becomes ≤150 lines.
- `mcp/dispatcher.ts` (652) → `mcp/pool.ts` + `mcp/reconcile.ts` +
  `mcp/introspect.ts`.

---

## 5. The local-state control tier — KEEP, legitimize, document

This was previously the audit's one open decision. **It is now decided: keep the
entire tier.** The TUI dashboard, the operator CLI, the `SecretsManager` screen,
and the encrypted SQLite credential store are **intended local-state
architecture** — the control plane for Sym's primary extension point (MCP
connectors and their OAuth tokens). The job here is to make that tier coherent and
**document it as a first-class architectural tier**, not to delete it.

The facts that motivated the old "contradiction" finding still hold — but the
resolution is documentation, not removal:

- `apps/agent/src/tui/` (10 files, incl. `SecretsManager`, `Dashboard`,
  `BuilderScreen`, `DetailScreen`, the `App` router) is the Ink/React operator
  dashboard. **Kept.**
- `apps/agent/src/cli/` (4 files) provides the `sym status / connector / apply /
secret` verbs against the admin HTTP routes and the SQLite store. **Kept.**
- `mcp/store.ts` + `apps/agent/.sym/credentials.db` — the AES-256-GCM-encrypted
  OAuth token store. **Kept** (was never optional).
- The README "no dashboard" line and the FUTURE.md "collapse removed
  Secrets/Dashboard" line were the _defect_ — they describe a state that does not
  match the (intended) code. _(Z09-01, Z09-08, Z13-01, Z14-06/12 — all recast from
  "delete because stateless" to "legitimize the control tier.")_

### What "legitimize + document" means concretely (backlog **C03**)

1. **Re-frame the docs.** README: "no message database and no _web_ dashboard;
   Sym ships an operator TUI + CLI and an encrypted local credential store as a
   deliberate control tier." FUTURE.md: describe what the collapse actually
   removed (the multi-service Postgres web dashboard) and acknowledge the
   rebuilt-in-agent MCP client + operator CLI + credential store. ARCHITECTURE.md
   (C22) documents the **two tiers** explicitly: _conversational_ (stateless,
   thread-as-memory) and _control_ (local-state: TUI/CLI + encrypted SQLite).
2. **Harden the credential CLI surface.** `sym secret set` is stdin-only — no
   plaintext secret as a positional arg (it would leak via the process table).
   _(Z09-14.)_
3. **Dependency placement.** Move `ink`/`react`/`ink-text-input` to
   `devDependencies` **only if** the Hono server runtime does not import them at
   boot (the TUI is launched by the `sym` CLI, not the server). If the server path
   does import them, keep them as runtime deps and document why. This is the one
   coupling that feeds the C06 `--prod` hardening, so verify before moving.
   _(Z09-13.)_
4. **Tests are kept.** The 5 `tui.*` test files are **not** dead-code tests under
   this reframe; they gain a real-wire smoke test for the surface they cover
   (C09), and their wall-clock `tick()` flakiness is fixed (C23), rather than being
   deleted. _(Z13-01 recast, Z09-07.)_

### The exact surviving file set (so C03 is executable from the docs alone)

**`apps/agent/src/tui/` — all kept, cleaned:**
`index.tsx` (launch + the `NO_COLOR`/isTTY hardening, C37), `App.tsx` (router),
`screens/Dashboard.tsx`, `screens/DetailScreen.tsx`, `screens/BuilderScreen.tsx`,
`screens/SecretsManager.tsx`, and the `ui/` helpers (`theme.ts`, the shared
`StepContent`/`SummaryLine` components consolidated per Z09-04/05/17). No screen is
removed; `SecretsManager` is **kept**.

**`apps/agent/src/cli/` — all kept, cleaned:**
`index.ts` (the `sym` entry + the isTTY guard on the `menu`/`tui` subcommands,
C37), `admin-client.ts` (HTTP client for the `/admin/*` routes),
`config-store.ts` (local JSON config), `secrets.ts` (stdin-only `set`, hardened
per Z09-14).

**Credential store — kept:** `apps/agent/src/mcp/store.ts` (+ the file-permission
hardening in C27), exported through `mcp/index.ts` as part of the documented
public surface (C16).

The only things that disappear from this tier are genuinely-dead lines _inside_
kept files (swept in C10 under knip's confirmation) — never a screen, a verb, or
the store.

---

## 6. Target repository tree (before → after)

### Before (today)

```
sym/
  apps/agent/
    src/
      builtin-tools.ts        1679 lines  ← monolith
      handle-turn.ts          1057 lines  ← 4 concerns
      server.ts                804 lines  ← inner-fn soup + 3× sig verify
      slack-client.ts          570 lines  ← WebApiSlackClient (WRONG package)
      pi/loop.ts               734 lines  ← 350-line runLoopPi
      mcp/dispatcher.ts        652 lines  ← 5 concerns
      tui/                     10 files    ← Dashboard, SecretsManager, … (INTENDED control tier; docs disclaim it — fix docs)
      cli/                      4 files    ← sym status/connector/apply/secret (INTENDED operator tooling)
      confirmations.ts  223     ← destructive-tool confirm/cancel registry (UNOWNED in first pass → Z15)
      slack-guard.ts    112     ← LLM relevance/injection guard, fail-open (UNOWNED → Z15)
      assistant.ts       58     ← assistant-panel greeting (UNOWNED → Z15)
      …
  packages/
    contracts/  (+ stale dist/: audit, connectors, memory, sandbox, soul)
    kernel/     (+ stale dist/: soul, tone, loop; OwnerIdentity misplaced)
    adapter/slack/ (+ stale dist/: dedup; client.ts 520 = types+iface+retry)
  scripts/      dev-setup.sh, setup-macos.sh, setup-linux.sh (DEAD: Postgres/Redis), render-manifest.js
  slack/        README.md + manifest.template.yml   ← (template ALREADY has correct scopes;
                                                       NO rendered manifest is tracked)
  dokploy/      env-template + agent.yml (missing MCP vars)
  README.md     (lists only apps/agent + docs; README.md:45 prose has wrong scopes; 9 of ≥15 env vars)
  (no CONTRIBUTING / SECURITY / ARCHITECTURE / CHANGELOG / CODE_OF_CONDUCT / AGENTS.md / issue templates)
```

### After (target)

```
sym/
  apps/agent/
    src/
      tools/                  ← builtin-tools split: registry + one file per tool family
      handle-turn.ts          ← orchestrator only (~250 lines)
      task-card-manager.ts    ← extracted
      turn-context.ts         ← extracted (history + viewed-channel resolvers)
      stream-reply.ts         ← extracted (3 named delivery helpers)
      server.ts               ← thin; verifySlack middleware
      event-router.ts         ← extracted (processEvent / processSlashCommand)
      pi/loop.ts              ← runLoopPi ≤150 lines + extracted builders
      confirmations.ts        ← reviewed (Z15); blocks param typed SlackBlock[]; replay logged
      slack-guard.ts          ← reviewed (Z15); fail-open documented; SLACK_GUARD_TOOLS commented
      assistant.ts            ← reviewed (Z15); owner-gate JSDoc added
      mcp/
        pool.ts  reconcile.ts  introspect.ts   ← dispatcher split
        store.ts  inject.ts  config.ts  source.ts  composite.ts  materialize.ts
        oauth-registry.ts  providers/          ← supplement fixes (Z08-21..30): no dead listAsync,
                                                  no client leak, finite timeout, named temp dirs
      cli/                    ← KEPT operator CLI, hardened (stdin-only secrets; isTTY guards)
      tui/                    ← KEPT operator dashboard incl. SecretsManager (NO_COLOR honored)
      (slack-client.ts DELETED — moved into the adapter package)
  packages/
    contracts/      ← clean dist; sideEffects:false; OwnerIdentity now lives here
    kernel/         ← documented boundary; dead exports pruned; clean dist
    adapter/slack/
      src/  types.ts  client.ts  web-api-client.ts  retry.ts  normalize.ts …
                    ← single Slack client; client.ts split 3 ways; clean dist
  scripts/          ← ONLY render-manifest.js + a new minimal setup.sh
  slack/            ← README.md + manifest.template.yml; a CI guard PREVENTS a rendered
                      manifest from ever being committed (none is today)
  dokploy/          ← env-template + agent.yml: complete MCP/OAuth var set
  examples/         ← NEW: sample connector config.json + annotated .env walkthrough
  README.md         ← accurate layout (incl. the control tier), scopes via manifest:render, full env table
  ARCHITECTURE.md   ← NEW: codemap + invariants + TWO-TIER model + per-turn latency/cost budget
  CONTRIBUTING.md   CHANGELOG.md   SECURITY.md   CODE_OF_CONDUCT.md   AGENTS.md   ← NEW
  THIRD-PARTY-LICENSES.md   ← NEW: MIT/ISC attribution for runtime deps
  .github/ISSUE_TEMPLATE/   .github/dependabot.yml (npm + actions)   ← NEW
  knip.json   .dependency-cruiser.js   docs/reference/dependency-graph.*   ← NEW: enforcement + generated DAG
```

---

## 7. Naming & boundary rules (the conventions to lock in)

These become the enforced rules (via ESLint `no-restricted-imports`,
dependency-cruiser, and knip — backlog C07), so future AI-assisted work cannot
re-introduce the drift:

1. **Dependency DAG, enforced:** `@sym/contracts` imports nothing in `@sym/*`;
   `@sym/kernel` and `@sym/adapter-slack` import only `@sym/contracts`;
   `packages/*` must never import from `apps/*`. (R1.7, R3.3.) Circular deps are a
   CI error. (R3.5.)
2. **Concrete implementations live with their interface.** No more impl-in-app /
   interface-in-package splits. (Z05-01.)
3. **Domain types live in `@sym/contracts`.** Not in a runtime file like
   `prompt.ts` (`OwnerIdentity`) or `slack.ts` (`ReceiptFooterField` → `domain.ts`).
   (Z11-02, Z10-06.)
4. **One file per logical unit; ≤500 lines.** Enforced by `max-lines` (warn 400),
   `complexity` (15), `max-depth` (4), `max-params` (4). (R3.1, R3.10.)
5. **Public package surface is intentional.** `index.ts` exports only what
   external callers use; internal helpers and test-only seams are not re-exported
   (or carry a `_` prefix). No internal barrel files. (R3.7; Z10/Z11/Z12 export-
   surface findings.)
6. **`dist/` is generated, never stale.** A prebuild `clean` step on every
   package; `dist/` stays out of source review. (Z10-02, Z11-01, Z12-01.)
7. **Server logs use `console.info/warn/error`, never `console.log`.** The CLI is
   the documented exception (operator-facing output) — scope the rule to
   server/daemon code. (Z09-09.)
8. **Every env var the agent reads is documented** in `.env.example` and the
   README/`docs/reference/env-vars.md`. Prefer routing knobs through `config.ts`
   over scattered `process.env[]`. (Z03-03, Z04-05, Z09-06, Z14-02/13.)

---

## 8. What does NOT change

To keep the refactor honest about scope, these are explicitly out of scope —
they are already correct (per R1 "what Sym gets right") or are deliberate trade-
offs to leave alone:

- The ESM / NodeNext / `verbatimModuleSyntax` / `composite: false` setup.
- The three-tier `apps/` / `packages/` / `packages/adapter/` convention.
- The stateless "thread is the _conversational_ memory" runtime model.
- The Pi-loop → Fireworks → streamed-reply core flow.
- **The local-state control tier itself** — the operator TUI, the `sym` CLI, the
  `SecretsManager` screen, and the SQLite credential store all **stay**. Only
  their _documentation framing_, a few hardening points (stdin-only secrets, file
  permissions, `NO_COLOR`/isTTY), and dead lines _inside_ kept files are in scope.
  The tier is intended architecture, not a refactor target for removal.
- Husky + lint-staged + commitlint discipline.

Proceed to [`BACKLOG.md`](./BACKLOG.md) for the ordered execution plan.
