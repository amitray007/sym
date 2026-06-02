# Zone Z13: Tests & QA Strategy

> **Inventory re-baselined 2026-06-02.** The first draft of this zone audited a
> stale snapshot: it claimed "53 test files," named three files that **do not
> exist** (`workspace-context.test.ts`, `registry.test.ts`, `retry.test.ts`), and
> omitted ~13 files that **do**. The real tree is **48 test files** (47
> `*.test.ts`/`*.test.tsx` + 1 `contracts.test-d.ts`). The full corrected
> inventory is in the new **"Test inventory (ground truth — 48 files)"** section
> below; the findings table and detail are otherwise preserved, with Z13-01
> recast in light of the owner decision to **keep** the local-state control tier.

## Summary

The test suite is architecturally strong and largely follows the team's "real-wire first" principle. There are **48 test files** (47 `*.test.ts`/`*.test.tsx` plus one `contracts.test-d.ts` typecheck file) covering a meaningful cross-section of the codebase. The MCP subsystem in particular is exceptionally well-tested with genuine subprocess-spawning and in-process HTTP server integration tests (`mcp.integration.test.ts`, `mcp.reconcile.test.ts`, `mcp.oauth.integration.test.ts`). The Slack adapter layer has thorough unit coverage across all its modules. The server route contract tests and `admin.*` real-wire tests close the HTTP control-plane gap. The three previously-unowned security files **are** in fact tested — `confirmations.test.ts`, `slack-guard.test.ts`, and `assistant.test.ts` all exist — though the highest-value adversarial path (`POST /slack/interactivity`) is not exercised (see Z15-08 / chunk C26).

However, the suite has structural problems that would prevent a clean OSS launch. The most pressing: there is **no code-coverage instrumentation configured**, so blind spots are invisible (Z13-02, critical). A handful of source modules of significant size have weak or missing dispatch-level coverage (`run_cli`, `set_plan`, `update_task` in `builtin-tools.ts`; the `pi/loop.ts` streaming path; the `server.ts` assistant event routes; and **`workspace-context.ts`, which genuinely has no test** — see the reconciliation note under Z13-06). The `vi.mock` hoisting antipattern in `mcp.test.ts` references `vi` before the import — harmless in practice (Vitest hoists), but confusing to new readers. Real-wire and mocked "integration" tests are mixed together under the same `pnpm test` command with no separation or labelling, making CI feedback ambiguous. The `cli.commands.test.ts` file spies on `console.log` in-process, which is the exact race condition the team has been burned by before.

The **five `tui.*` test files** (`tui.app`, `tui.dashboard`, `tui.builder-screen`, `tui.detail-screen`, `tui.secrets-manager`) cover the operator dashboard. Under the original framing these were called "dead-code tests for a North-Star-violating control plane." **That framing is withdrawn** (owner decision 2026-06-02): the TUI/CLI/SecretsManager + SQLite credential store are **intended local-state architecture and are kept**. The tests are therefore **kept too** — they gain a real-wire smoke test for the surface they cover (C09) and their wall-clock `tick()` flakiness is fixed (Z13-14 / C23), rather than being deleted (Z13-01 recast below).

---

## Test inventory (ground truth — 48 files, verified against `HEAD`)

`find apps packages -path '*/tests/*' -name '*.test*'` → **48** files.

**`apps/agent/tests/` (40 files):**

| File                            | Covers                                 | Real-wire?           |
| ------------------------------- | -------------------------------------- | -------------------- |
| `admin.connectors.test.ts`      | `/admin/connectors` routes             | yes (loopback)       |
| `admin.reload.test.ts`          | `POST /admin/reload`                   | yes (loopback)       |
| `assistant-context.test.ts`     | assistant context store                | unit                 |
| `assistant.test.ts`             | `assistant.ts` greeting handler        | unit                 |
| `builtin-tools.test.ts`         | builtin tool dispatch (most tools)     | unit                 |
| `cli.admin-client.test.ts`      | CLI → `/admin/*` HTTP client           | unit                 |
| `cli.allowlist.test.ts`         | CLI allowlist parsing                  | unit                 |
| `cli.commands.test.ts`          | `sym` CLI verbs (in-proc server)       | real-wire            |
| `cli.config-store.test.ts`      | local JSON config store                | unit                 |
| `cli.index.test.ts`             | CLI entry / arg routing                | unit                 |
| `cli.secrets.test.ts`           | `sym secret` verbs                     | unit                 |
| `confirmations.test.ts`         | confirm/cancel registry                | unit                 |
| `handle-turn.test.ts`           | turn orchestration (loop mocked)       | unit                 |
| `manifest-prompts.test.ts`      | starter-prompt loading from YAML       | unit                 |
| `mcp.integration.test.ts`       | MCP stdio subprocess                   | real-wire            |
| `mcp.oauth.integration.test.ts` | MCP OAuth callback flow                | real-wire            |
| `mcp.reconcile.test.ts`         | connector reconcile                    | real-wire            |
| `mcp.source.test.ts`            | connector config loading               | unit (fs)            |
| `mcp.test.ts`                   | dispatcher (mocked Client)             | unit                 |
| `meta-tools.test.ts`            | meta-tool bridge                       | unit                 |
| `name-resolver.test.ts`         | id/name resolution + cache             | unit                 |
| `owner-gate.test.ts`            | owner-gate predicate                   | unit                 |
| `pi-loop.test.ts`               | whimsy/verb/subscriber filters         | unit                 |
| `pi-tools.test.ts`              | `bridgeTools` + composite routing      | unit                 |
| `plan-controller.test.ts`       | plan/task state machine                | unit                 |
| `reply-cleanup.test.ts`         | `parseRemovals`/`applyRemovals`        | unit                 |
| `run-cli.test.ts`               | `runCli` allowlist/exec                | unit                 |
| `safe-fetch.test.ts`            | SSRF blocklist                         | unit                 |
| `server.test.ts`                | server routes (sig/url_verif/commands) | unit (`app.request`) |
| `slack-client.test.ts`          | `WebApiSlackClient` (retry path)       | unit                 |
| `slack-guard.test.ts`           | LLM relevance guard                    | unit                 |
| `task-card-manager.test.ts`     | task-card lifecycle                    | unit                 |
| `think-router.test.ts`          | thinking-level heuristic               | unit                 |
| `thinking-copy.test.ts`         | shimmer-phrase rotation                | unit                 |
| `tui.app.test.tsx`              | TUI App router                         | unit (ink-testing)   |
| `tui.builder-screen.test.tsx`   | BuilderScreen                          | unit (ink-testing)   |
| `tui.dashboard.test.tsx`        | Dashboard                              | unit (ink-testing)   |
| `tui.detail-screen.test.tsx`    | DetailScreen                           | unit (ink-testing)   |
| `tui.secrets-manager.test.tsx`  | SecretsManager                         | unit (ink-testing)   |
| `web-search.test.ts`            | DDG HTML parse                         | unit                 |

**`packages/adapter/slack/tests/` (6 files):** `blocks.test.ts`,
`normalize.test.ts`, `receipt.test.ts`, `render.test.ts`, `thread.test.ts`,
`verify.test.ts`.

**`packages/contracts/tests/` (1 file):** `contracts.test-d.ts` (type-level).

**`packages/kernel/tests/` (1 file):** `prompt.test.ts`.

**Corrections vs the first-draft inventory:**

- **Removed phantoms (do NOT exist):** `workspace-context.test.ts`,
  `registry.test.ts`, `retry.test.ts`.
- **Added (exist, were omitted):** `confirmations`, `slack-guard`, `owner-gate`,
  `safe-fetch`, `plan-controller`, `assistant`, `assistant-context`,
  `cli.allowlist`, `cli.config-store`, `cli.index`, `cli.secrets`,
  `mcp.oauth.integration`, `task-card-manager`.
- **`workspace-context.ts` genuinely has NO test** — so Z13-06's "add one" and
  C09's "add `workspace-context.ts` tests" are **correct** (the first-draft
  contradiction, where Z13 listed `workspace-context.test.ts` as present, is
  resolved: it is absent).

---

## Findings

| ID     | Severity | Category | Title                                                                                                                                                                               | Files                                                                                                                                                                   | Effort  |
| ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Z13-01 | medium   | testing  | TUI tests cover the (kept) local-state control tier but lack a real-wire smoke test                                                                                                 | `tests/tui.app.test.tsx`, `tests/tui.dashboard.test.tsx`, `tests/tui.builder-screen.test.tsx`, `tests/tui.detail-screen.test.tsx`, `tests/tui.secrets-manager.test.tsx` | small   |
| Z13-02 | critical | testing  | No code-coverage instrumentation configured                                                                                                                                         | `apps/agent/vitest.config.ts`, all `packages/*/vitest.config.ts`                                                                                                        | trivial |
| Z13-03 | high     | testing  | `run_cli`, `set_plan`, `update_task` dispatch paths have zero test coverage                                                                                                         | `tests/builtin-tools.test.ts`, `src/builtin-tools.ts:1049-1679`                                                                                                         | small   |
| Z13-04 | high     | testing  | `cli.commands.test.ts` uses `console.log` spy inside a real server process                                                                                                          | `tests/cli.commands.test.ts:56-68`                                                                                                                                      | small   |
| Z13-05 | high     | testing  | `server.ts` assistant-panel routes have no tests (assistant_thread_context_changed, shortcut, assistant messages)                                                                   | `tests/server.test.ts`, `src/server.ts`                                                                                                                                 | medium  |
| Z13-06 | high     | testing  | `workspace-context.ts` (176 lines) has zero test coverage                                                                                                                           | `src/workspace-context.ts`                                                                                                                                              | small   |
| Z13-07 | high     | testing  | Real-wire integration tests run alongside unit tests with no separation or timeout segregation                                                                                      | `apps/agent/vitest.config.ts`, CI `ci.yml`                                                                                                                              | small   |
| Z13-08 | medium   | testing  | `pi/loop.ts` `runLoopPi` return path (Reply construction, usage extraction, receipt building) not tested                                                                            | `tests/pi-loop.test.ts`, `src/pi/loop.ts:387-734`                                                                                                                       | medium  |
| Z13-09 | medium   | testing  | `packages/kernel` — `ToolRegistry` and `buildReceipt` have no tests                                                                                                                 | `packages/kernel/tests/prompt.test.ts`, `packages/kernel/src/tools.ts`, `packages/kernel/src/receipt.ts`                                                                | small   |
| Z13-10 | medium   | testing  | `packages/adapter/slack` — `withSlackRetries` / `mapSlackError` in `client.ts` tested only indirectly through `WebApiSlackClient` wrapper                                           | `packages/adapter/slack/tests/`, `packages/adapter/slack/src/client.ts:446-488`                                                                                         | trivial |
| Z13-11 | medium   | testing  | `packages/contracts` — `RenderIntent` types and `render.ts` have no type-level assertion coverage                                                                                   | `packages/contracts/tests/contracts.test-d.ts`, `packages/contracts/src/render.ts`                                                                                      | trivial |
| Z13-12 | medium   | ai-slop  | `mcp.test.ts` references `vi` before the `import { vi }` statement (works due to Vitest hoisting, but misleading)                                                                   | `tests/mcp.test.ts:18-21`                                                                                                                                               | trivial |
| Z13-13 | medium   | testing  | `handle-turn.test.ts` uses bare `setTimeout(r, 0)` to settle fire-and-forget side effects (setTitle) — implicit ordering assumption                                                 | `tests/handle-turn.test.ts:647,684,706`                                                                                                                                 | small   |
| Z13-14 | medium   | testing  | TUI `tick()` helpers use wall-clock `setTimeout(_, 50)` — inherently flaky on slow CI                                                                                               | `tests/tui.app.test.tsx:31`, `tests/tui.dashboard.test.tsx:28`, `tests/tui.detail-screen.test.tsx:42`, `tests/tui.secrets-manager.test.tsx:26`                          | small   |
| Z13-15 | medium   | testing  | `server.ts` `/slack/commands` happy-path test asserts only status 200; the actual `handleTurn` call failure is not observed                                                         | `tests/server.test.ts:213-258`                                                                                                                                          | small   |
| Z13-16 | low      | testing  | `mcp.source.ts` — `configPath()`, `loadCliAllow()`, `loadCliDescribe()` are only tested via mocking (never real-wire)                                                               | `tests/mcp.source.test.ts`, `src/mcp/source.ts`                                                                                                                         | trivial |
| Z13-17 | low      | testing  | `think-router.ts` — the medium/high branching heuristic could regress silently; no property-based or boundary sweep tests                                                           | `tests/think-router.test.ts`                                                                                                                                            | trivial |
| Z13-18 | low      | naming   | Test file naming is inconsistent: `cli.admin-client.test.ts`, `admin.connectors.test.ts` and `admin.reload.test.ts` use different prefix conventions for testing the same subsystem | `tests/cli.admin-client.test.ts`, `tests/admin.connectors.test.ts`, `tests/admin.reload.test.ts`                                                                        | trivial |
| Z13-19 | low      | testing  | `pi-tools.test.ts` tests the `bridgeTools` bridge but does not assert the Pi Agent actually receives the tool schemas in its constructor call                                       | `tests/pi-tools.test.ts`                                                                                                                                                | trivial |
| Z13-20 | low      | testing  | `manifest-prompts.test.ts` relies on the YAML file at `slack/manifest.template.yml` being present at runtime — brittle to repo layout changes                                       | `tests/manifest-prompts.test.ts:10`                                                                                                                                     | trivial |
| Z13-21 | low      | testing  | `admin.reload.test.ts` only has 2 test cases for `POST /admin/reload` — the error path (malformed config, broken connector, empty-body request) is unexercised                      | `tests/admin.reload.test.ts`                                                                                                                                            | small   |

---

## Detail

### Z13-01 — TUI tests cover the kept control tier but lack a real-wire smoke test (medium) — RECAST

> **Recast 2026-06-02.** The original finding called these "dead-code tests for a
> North-Star-violating control plane" and recommended **deleting** them. That is
> **withdrawn.** The owner has decided the TUI + CLI + `SecretsManager` + SQLite
> credential store are **intended local-state architecture and are kept** (see
> 00-overview §3, TARGET-STRUCTURE §5, backlog C03). "Stateless" describes the
> _conversational_ tier only. So the tests are kept too — the action is to
> _strengthen_ them, not remove them.

**Evidence:**

```
tests/tui.secrets-manager.test.tsx:11-12
vi.mock('../src/cli/secrets.js', ...)
vi.mock('../src/cli/config-store.js', ...)
```

The five TUI test files cover `SecretsManager`, `Dashboard`, `BuilderScreen`, `DetailScreen`, and the `App` router. They are **fully mocked** — every backing module (`cli/secrets.ts`, `cli/admin-client.ts`, `cli/config-store.ts`) is `vi.mock`'d, so the tests assert ink-rendering behaviour against stub data but never exercise the real CLI/store wiring on a live wire. For a _kept, first-class_ control tier, that mocked-only coverage is the gap: there is no smoke test proving the operator surface actually talks to the admin routes / SQLite store end-to-end.

**Recommendation:** Keep all five test files. Add **one real-wire smoke test** (per C09 / Z09-07) that drives at least one operator surface (e.g. `sym status` or the Dashboard's connector read) against a live in-process admin server + a temp SQLite store, asserting the real round-trip. Separately, fix the wall-clock `tick()` flakiness in these files (Z13-14 / C23). Do **not** add a "remove with src/tui" TODO — the tier is intended and documented.

---

### Z13-02 — No code-coverage instrumentation configured (critical)

**Evidence:**

All four `vitest.config.ts` files lack a `coverage` section. The CI `ci.yml` runs `pnpm test` but there is no coverage report, threshold check, or upload. This means blind spots in the test suite are entirely invisible.

**Recommendation:** Add a `coverage` block to `apps/agent/vitest.config.ts` (and the three package configs):

```ts
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov'],
  thresholds: { lines: 80, branches: 75 },
}
```

Upload LCOV to Codecov or similar in CI. This converts Z13-03/05/06/08/09 from "suspected gaps" into confirmed, measurable problems.

---

### Z13-03 — `run_cli`, `set_plan`, `update_task` dispatch paths have zero test coverage (high)

**Evidence:**

`tests/builtin-tools.test.ts` contains describe blocks for every single builtin tool except three: `run_cli` (line 181 — only appears in the `list()` name-assertion), `set_plan`, and `update_task`. Yet these are complex: `run_cli` (lines 1049–1095 of `builtin-tools.ts`) validates the allowlist, normalises argv, calls `runCli()`, and formats errors. `set_plan` and `update_task` delegate to `PlanController` but also convert result shapes.

**Recommendation:** Add `describe('dispatch() — run_cli', ...)` covering: allowlisted binary success, non-allowlisted binary rejection, path-traversal rejection, and timeout. Add `describe('dispatch() — set_plan', ...)` and `describe('dispatch() — update_task', ...)` covering the success path and the already_planned/no_plan/unknown_id failure modes.

---

### Z13-04 — `cli.commands.test.ts` uses `console.log` spy inside a real server process (high)

**Evidence:**

```ts
// tests/cli.commands.test.ts:56-68
const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
  logs.push(a.map(String).join(' '));
});
```

This test starts a real Hono server (via `@hono/node-server`) inside the same process, then spies on `console.log` to capture `sym` CLI output. The memory note for this project explicitly states: "the sym CLI real-wire tests spy on console.log in-process + JSON.parse it, so any server `console.log` races into `--json` output (flaky CI, bit twice)." An unrelated background server async log could corrupt the JSON parse. The server currently uses `console.info/warn` (per the convention) but any future server-side `console.log` would silently break this test.

**Recommendation:** Use `stdout` subprocess capture instead of in-process `console.log` spying. Alternatively, add a comment: `// WARNING: this test spies on console.log in-process with a live server; any server console.log will corrupt --json output.`

---

### Z13-05 — `server.ts` assistant-panel routes lack test coverage (high)

**Evidence:**

`tests/server.test.ts` covers: bad-signature 401, url_verification echo, stale timestamp, one `assistant_thread_started` leak-gate case, and the `/slack/commands` path (5 cases). Absent from the tests:

- `assistant_thread_context_changed` event routing (large block in `server.ts`)
- Shortcut events (`event.type === 'shortcut'`)
- DM and mpim event routing through `normalizeSlackEvent` → `handleTurn`
- The `POST /mcp/oauth/callback` route (OAuth completion)
- `/admin/reload` called from a non-loopback IP (loopback guard in `server.ts`)

These are covered in the integration test for admin routes (`admin.reload.test.ts`) but that test does not check the security guard. The OAuth callback route is completely untested.

**Recommendation:** Add to `server.test.ts`: a test for the loopback guard rejecting a non-127 origin; a test for the shortcut entry surface; a test for `assistant_thread_context_changed` updating the context store. The OAuth callback can remain in `mcp.oauth.integration.test.ts`.

---

### Z13-06 — `workspace-context.ts` has zero test coverage (high)

**Evidence:**

`src/workspace-context.ts` (176 lines) exports `loadWorkspaceContext()` and `healthCheckTokens()`. No file in `tests/` imports or exercises these. `loadWorkspaceContext` validates required env vars and constructs the dual-client (bot + user) structure; `healthCheckTokens` does live `auth.test()` calls against both tokens. These are the first things run at server boot.

**Recommendation:** Add `tests/workspace-context.test.ts` covering: `loadWorkspaceContext` with a complete config (produces a `WorkspaceContext` with the right fields), with a missing required field (throws), and the user-token-absent path (produces a context with `null` userClient).

> **Reconciliation (2026-06-02):** confirmed against the 48-file tree —
> `workspace-context.test.ts` does **not** exist. The first-draft inventory wrongly
> listed it as present, contradicting this finding and backlog C09. The file is
> absent; "add one" (here and in C09) is correct. This is now consistent across
> Z13 and the backlog.

---

### Z13-07 — Real-wire and unit tests are not separated (high)

**Evidence:**

`apps/agent/vitest.config.ts` includes all `tests/**/*.test.ts` in one run. Tests like `mcp.integration.test.ts`, `mcp.reconcile.test.ts`, `mcp.oauth.integration.test.ts`, `admin.reload.test.ts`, and `admin.connectors.test.ts` spawn real child processes, bind random ports, and have 30 s timeouts. They run in the same process and pool as pure unit tests with 0 ms execution time. This means:

1. A single subprocess-spawning failure stalls the entire suite.
2. There is no way to run only the fast unit tests for tight development iteration.
3. The 20-minute CI timeout is generous enough to hide when slow tests start regressing.

**Recommendation:** Split into two Vitest configurations: `vitest.config.ts` (unit, no subprocess, `testTimeout: 5_000`) and `vitest.config.integration.ts` (integration, subprocess OK, `testTimeout: 30_000`). Name integration files `*.integration.test.ts` (already done for `mcp.integration.test.ts` and `mcp.oauth.integration.test.ts`; also apply to `admin.reload`, `admin.connectors`, `mcp.reconcile`, `cli.commands`). Add a `test:unit` and `test:integration` script in `package.json`.

---

### Z13-08 — `pi/loop.ts` return path not tested (medium)

**Evidence:**

`tests/pi-loop.test.ts` tests three narrow areas: `nextWhimsicalStatus`, `friendlyVerb`, and two subscriber-filter scenarios. The actual `runLoopPi` function (lines 387–734, the core AI loop) is only tested via `handle-turn.test.ts` with `runLoopPi` mocked out entirely. The internal Pi Agent message-to-Reply conversion (`extractUsage`, `toAgentMessages`, receipt building, the tool-call dispatch bridge) is never exercised directly.

**Recommendation:** Add tests in `pi-loop.test.ts` that drive the subscriber directly (as the existing tests do) to cover: `tool_call_start` → `onToolStart` callback fired; `tool_result` → `onToolEnd` callback fired; `message_complete` → reply assembled with correct `markdown` and `receipt.model`. These can use the existing fake Agent pattern without network calls.

---

### Z13-09 — `packages/kernel` — `ToolRegistry` and `buildReceipt` have no tests (medium)

**Evidence:**

`packages/kernel/tests/prompt.test.ts` only covers `buildSystemPrompt`, `buildTurnContextPrompt`, and `buildUserTurnContent`. The other two exports — `ToolRegistry` (from `src/tools.ts`) and `buildReceipt` (from `src/receipt.ts`) — have no tests. `ToolRegistry` is the interface between the Pi Agent and all tool dispatchers; `buildReceipt` assembles the turn receipt from raw usage data. Both are used by multiple callers.

**Recommendation:** Add `packages/kernel/tests/registry.test.ts` covering `ToolRegistry.getDispatcher()`, `register()`, and the `dispatch()` routing. Add `packages/kernel/tests/receipt.test.ts` covering `buildReceipt` with usage present/absent, toolsInvoked empty/non-empty, and durationMs boundaries.

---

### Z13-10 — `withSlackRetries` / `mapSlackError` tested only through `WebApiSlackClient` (medium)

**Evidence:**

```ts
// packages/adapter/slack/src/client.ts:446-488
export async function withSlackRetries<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T>;
export function mapSlackError(err: SlackApiError): SlackActionError;
```

These two utility functions are exported from the adapter but have no direct unit tests. Their behaviour is tested indirectly through `slack-client.test.ts` (the retry test on line 371 exercises the retry path via `WebApiSlackClient.chatPostMessage`). `mapSlackError` has no test at all.

**Recommendation:** Add `packages/adapter/slack/tests/retry.test.ts` with direct calls to `withSlackRetries` (success on first try, success on second try after 429, exhausted retries throw) and `mapSlackError` (maps known Slack error codes to structured errors).

---

### Z13-11 — `packages/contracts` — `RenderIntent` types have no type-level assertions (medium)

**Evidence:**

`contracts.test-d.ts` has six type assertions covering branded IDs, `ToolResult`, `ProviderInterface`, `Reply`, and `Result`. It does not cover `RenderIntent`, `TableRenderIntent`, `CardRenderIntent`, or `RenderTableCell`. These are non-trivial discriminated types used by the render pipeline.

**Recommendation:** Add `expectTypeOf<RenderIntent>().toHaveProperty('kind')` and a `satisfies TableRenderIntent` assertion to `contracts.test-d.ts` to ensure the discriminated union is structurally sound.

---

### Z13-12 — `vi` referenced before import in `mcp.test.ts` (medium)

**Evidence:**

```ts
// tests/mcp.test.ts:18-21 (before any import)
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => { return { Client: vi.fn() }; });
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => { ... });
// ...
import { afterEach, beforeEach, ..., vi } from 'vitest'; // line 33
```

Vitest hoists `vi.mock()` calls so this works at runtime, but it reads as a reference to an undeclared `vi` global. This is confusing to new contributors who may not know the hoisting semantics.

**Recommendation:** Move the `vi.mock()` calls below the `import` statement (or to a dedicated `__mocks__` pattern). The comment on line 17 ("Module mocks must be declared before imports (hoisted by vitest)") should say "can be declared before imports" rather than "must", since the hoisting happens regardless.

---

### Z13-13 — `setTimeout(r, 0)` for fire-and-forget settlement in `handle-turn.test.ts` (medium)

**Evidence:**

```ts
// tests/handle-turn.test.ts:647
await new Promise((r) => setTimeout(r, 0));
expect(slack.setTitleCalls).toHaveLength(1);
```

Used in three tests to allow fire-and-forget `setTitle` async calls to settle. A single microtask tick is generally enough in Node, but this is an implicit assumption about the task scheduling depth inside `handleTurn`. If the implementation adds an additional async hop (e.g., a `resolveUser` call before `setTitle`), the test silently fails to wait long enough and produces a flaky false pass.

**Recommendation:** Replace with `await vi.waitFor(() => expect(slack.setTitleCalls).toHaveLength(1))`, which polls until the condition is met or the timeout fires. This is the same pattern used successfully in the TUI tests.

---

### Z13-14 — TUI `tick()` helpers use wall-clock `setTimeout(_, 50)` (medium)

**Evidence:**

```ts
// tests/tui.app.test.tsx:31
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
```

Same pattern in `tui.dashboard.test.tsx:28`, `tui.detail-screen.test.tsx:42`, `tui.secrets-manager.test.tsx:26`. These 50 ms delays are used to let `useInput` effect subscriptions wire up after `render()`. On a loaded CI host, 50 ms may not be enough.

**Recommendation:** Replace with `await vi.waitFor(...)` or use fake timers. If ink-testing-library's `waitFor` is available, use that. (Note: the TUI is **kept** — Z13-01 recast / C03 — so these files do not "go away"; they are hardened in place.)

---

### Z13-15 — `/slack/commands` happy-path test observes only HTTP 200 (medium)

**Evidence:**

```ts
// tests/server.test.ts:213-257
const res = await postTo('/slack/commands', body, ..., signedHeaders(body));
expect(res.status).toBe(200);
// No assertion on the background work or its failures.
```

The comment in the test explicitly acknowledges: "Background work … will fail in tests (no real Slack endpoint), but those errors are caught inside `processSlashCommand`." This means that if the background error handling is broken (e.g., an unhandled rejection escapes), the test would still pass.

**Recommendation:** Add a check that no unhandled rejection was emitted during the test. Alternatively, inject a mock Slack client so the background handleTurn can succeed, and assert that `handleTurn` was called via a spy.

---

### Z13-16 — `mcp/source.ts` helpers only tested via mocking (low)

**Evidence:**

`tests/mcp.source.test.ts` tests `loadConnectorConfigs()` with real filesystem operations. However, `configPath()`, `loadCliAllow()`, and `loadCliDescribe()` are only seen as vi.mock stubs in the TUI tests — never exercised with real files. `configPath()` reads `SYM_CONFIG_PATH` and falls back to `~/.sym/config.json`.

**Recommendation:** Add to `mcp.source.test.ts`: a test that sets `SYM_CONFIG_PATH` and asserts `configPath()` returns it; tests for `loadCliAllow()` returning env-var CLI lists; and `loadCliDescribe()` reading from a real config file.

---

### Z13-17 — `think-router.ts` heuristic has no boundary sweep (low)

**Evidence:**

`tests/think-router.test.ts` has 15 targeted cases. The heuristic (`MEDIUM_CLAUSE_THRESHOLD = 3`, thread depth threshold at `> 10`) is not pinned by boundary tests. A change from `> 10` to `>= 10` would not be caught.

**Recommendation:** Add explicit boundary tests: `threadDepth: 10` → `low`, `threadDepth: 11` → `medium`; `two_clauses` → `low`, `three_clauses` → `medium`.

---

### Z13-18 — Inconsistent test file naming convention (low)

**Evidence:**

Admin-related tests use two different prefix conventions:

- `tests/cli.admin-client.test.ts` (CLI subsystem prefix)
- `tests/admin.connectors.test.ts` (HTTP subsystem prefix)
- `tests/admin.reload.test.ts` (HTTP subsystem prefix)

A newcomer looking for "admin tests" might miss the first file.

**Recommendation:** Rename `tests/cli.admin-client.test.ts` to `tests/admin.client.test.ts` for consistency (the file tests the HTTP client for admin routes, not a CLI verb).

---

### Z13-19 — `pi-tools.test.ts` does not assert the Pi Agent receives tool schemas (low)

**Evidence:**

`tests/pi-tools.test.ts` tests `bridgeTools()` and `CompositeDispatcher` routing but asserts only that `registry.getDispatcher().list()` returns the right tools. It does not assert that when `bridgeTools` is called, the MCP tools actually appear in the Pi Agent's constructor call (the original debugging motivation for the test, per the file comment).

**Recommendation:** Add a test that calls `bridgeTools(registry, agentSpy)` and asserts the agent's tool list via a captured constructor argument.

---

### Z13-20 — `manifest-prompts.test.ts` relies on the YAML file path being stable (low)

**Evidence:**

```ts
// tests/manifest-prompts.test.ts:10-11
it('reads the real manifest at slack/manifest.template.yml and returns the configured prompts', () => {
  const prompts = loadStarterPrompts();
```

`loadStarterPrompts()` opens `slack/manifest.template.yml` relative to the source root. If the repo is restructured (the manifest moves, or the repo is consumed as a library), the test path breaks silently.

**Recommendation:** Document the path assumption in the test comment, and add a guard: `if (!existsSync(MANIFEST_PATH)) { return; }` to skip gracefully rather than throw.

---

### Z13-21 — `admin.reload.test.ts` only has 2 test cases (low)

**Evidence:**

`tests/admin.reload.test.ts` tests "add a connector" and "remove a connector" against a live loopback server. Missing: the error path when the config file is malformed (reload should return 200 with `source: 'none'`), and the loopback security guard (requests from non-127 IPs should be rejected).

**Recommendation:** Add at least: a test for `POST /admin/reload` when the config file is malformed JSON (should succeed with `source: 'none'`, not throw); a test for the loopback guard (requires injecting a spoofed `x-forwarded-for` header or a real non-loopback request).

---

## Proposed Chunks

### Chunk A: Strengthen the kept TUI/CLI tests (RECAST — no deletion)

**Goal:** the five `tui.*` test files are **kept** (the control tier is intended — C03) and gain a real-wire smoke test for at least one operator surface (live in-process admin server + temp SQLite store). The `cli.admin-client.test.ts` naming is normalized (→ `admin.client.test.ts`, Z13-18). No test is deleted. _(Maps into backlog C09 for the smoke test + C23 for the rename; the original "drop these" goal is withdrawn.)_
**Finding IDs:** Z13-01, Z13-18

### Chunk B: Add code-coverage instrumentation (no dependencies)

**Goal:** All four `vitest.config.ts` files have a `coverage` section with v8 provider, line/branch thresholds at 70%/65%, and an LCOV reporter. CI uploads coverage. Running `pnpm test --coverage` shows a coverage table. This is the single highest-leverage mechanical change.
**Finding IDs:** Z13-02

### Chunk C: Split unit/integration test runs (no dependencies)

**Goal:** A `vitest.config.integration.ts` exists in `apps/agent/`. The five slow real-wire test files (identified by `*.integration.test.ts` name, plus `admin.reload.test.ts`, `admin.connectors.test.ts`, `mcp.reconcile.test.ts`, `cli.commands.test.ts`) run only under the integration config. `pnpm test` runs unit tests only; `pnpm test:integration` runs the slow suite. CI runs both but displays them as separate steps.
**Finding IDs:** Z13-07

### Chunk D: Fill builtin-tools dispatch gaps (no dependencies)

**Goal:** `tests/builtin-tools.test.ts` has `describe` blocks for `run_cli`, `set_plan`, and `update_task` dispatch. All three cover the success path and the primary failure paths. `run_cli` tests use a real `node` subprocess (allowlisted). Coverage for `builtin-tools.ts` measurably improves.
**Finding IDs:** Z13-03

### Chunk E: Fix console.log spy risk in cli.commands test (no dependencies)

**Goal:** `cli.commands.test.ts` no longer uses `vi.spyOn(console, 'log')`. The `run()` helper captures the CLI output via subprocess stdout (spawning a child process running `tsx src/cli/index.ts`) rather than spying in-process. The real server started by `beforeEach` runs in the same process but no longer pollutes the capture channel.
**Finding IDs:** Z13-04

### Chunk F: Add workspace-context tests (no dependencies)

**Goal:** `tests/workspace-context.test.ts` exists and covers `loadWorkspaceContext` (valid config, missing required field) and `healthCheckTokens` (mocked Slack client, both success and failure cases).
**Finding IDs:** Z13-06

### Chunk G: Add kernel package tests (no dependencies)

**Goal:** `packages/kernel/tests/registry.test.ts` and `packages/kernel/tests/receipt.test.ts` exist with direct coverage of `ToolRegistry` and `buildReceipt`. The kernel vitest config includes both new files.
**Finding IDs:** Z13-09

### Chunk H: Fix flakiness risks in handle-turn and TUI tests (depends on Chunk A or standalone)

**Goal:** The three `setTimeout(r, 0)` usages in `handle-turn.test.ts` are replaced with `vi.waitFor(...)`. TUI `tick()` helpers are replaced with `vi.waitFor(...)` (or, if TUI is removed, this chunk is a no-op).
**Finding IDs:** Z13-13, Z13-14

### Chunk I: Patch minor quality issues (no dependencies)

**Goal:** `mcp.test.ts` vi.mock ordering clarified with an updated comment; `contracts.test-d.ts` adds `RenderIntent` assertions; `admin.reload.test.ts` adds two more test cases (malformed config, loopback guard); `mcp/source.ts` helpers get direct tests; `think-router.ts` boundary tests added.
**Finding IDs:** Z13-12, Z13-11, Z13-21, Z13-16, Z13-17
