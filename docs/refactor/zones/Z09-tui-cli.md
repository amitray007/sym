# Zone Z09: TUI & CLI (statefulness audit)

## Summary

This zone is the most architecturally conflicted in the codebase. The North Star is a
stateless, env-configured, no-dashboard, no-secrets-store deployable — yet this zone
delivers a full interactive terminal dashboard, a secrets manager backed by an encrypted
SQLite database, and a connector control-plane CLI complete with `sym secret set/ls/rm`.
Every file is live code (nothing is dead), which makes the question sharper: **is this
the right code to have?** The CLI half (`run-cli.ts`, `cli/`) is **justified** — it is
the operator's out-of-band wiring tool for MCP connectors and the run_cli allowlist, and
`run-cli.ts` is called directly by the production server. The TUI half (`tui/`) is
**architecturally conflicted** — the SecretsManager screen actively contradicts "no
secrets store," the Dashboard is a full stateful UI for a declared-stateless system, and
the README says the product has "no database, no dashboard" while shipping exactly that.
Code quality within each file is generally decent — good module docs, typed interfaces,
sensible decomposition — but several concrete problems exist: `injectValueTemplate` is
missing from the `Step` union type (type-safety hole); `statusColor()` is an exported
dead export in `theme.ts`; `fetchStatus()` in `admin-client.ts` is exported but never
called from production code; `offlineDetails()` is duplicated between `cli/index.ts` and
`tui/screens/Dashboard.tsx`; every operator-facing env var used by this zone
(`SYM_CONFIG_PATH`, `SYM_ENCRYPTION_KEY`, `SYM_DB_PATH`, `SYM_ADMIN_URL`,
`SYM_CLI_ALLOWLIST`) is absent from `.env.example` and README; `console.log` is used
throughout `cli/index.ts` (the operator-facing CLI), which the team convention allows
for non-server code but creates a sharply inconsistent exception to the
"server logs must use console.info/warn" rule that needs to be clearly documented; TUI
tests use `ink-testing-library` with mocked admin/config modules (not real-wire), which
violates the "real-wire integration test" convention for QA-testable features; and the
715-line `BuilderScreen.tsx` carries noticeable complexity that could be modestly reduced.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                                                                                            | Files                                              | Effort  |
| ------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------- |
| Z09-01 | critical | structure   | TUI SecretsManager directly contradicts the North Star                                                                                                                                                           | `tui/screens/SecretsManager.tsx`, `tui/app.tsx`    | medium  |
| Z09-02 | high     | dead-code   | `statusColor()` is an exported function never called anywhere                                                                                                                                                    | `tui/ui/theme.ts:21`                               | trivial |
| Z09-03 | high     | dead-code   | `fetchStatus()` and `StatusResponse` are exported but never used in production                                                                                                                                   | `cli/admin-client.ts:66,111`                       | trivial |
| Z09-04 | high     | type-safety | `injectValueTemplate` step is missing from the `Step` union — cast used to work around                                                                                                                           | `tui/screens/BuilderScreen.tsx:140-150,542,555`    | small   |
| Z09-05 | high     | duplication | `offlineDetails()` is implemented identically in both `cli/index.ts` and `Dashboard.tsx`                                                                                                                         | `cli/index.ts:117`, `tui/screens/Dashboard.tsx:33` | small   |
| Z09-06 | high     | docs        | Operator env vars `SYM_CONFIG_PATH`, `SYM_ENCRYPTION_KEY`, `SYM_DB_PATH`, `SYM_ADMIN_URL`, `SYM_CLI_ALLOWLIST` absent from `.env.example` and README                                                             | `.env.example`, `README.md`                        | small   |
| Z09-07 | high     | testing     | All TUI tests are mocked-unit (ink-testing-library + vi.mock) — no real-wire integration                                                                                                                         | `tests/tui.*.test.tsx`                             | large   |
| Z09-08 | medium   | structure   | Dashboard is a live stateful TUI for a declared "no-dashboard" deployable — contradicts North Star framing                                                                                                       | `tui/screens/Dashboard.tsx`, `README.md`           | medium  |
| Z09-09 | medium   | consistency | `cli/index.ts` uses `console.log` (operator output) while all server code uses `console.info/warn` — the distinction is legitimate but completely undocumented                                                   | `cli/index.ts` (62 occurrences)                    | small   |
| Z09-10 | medium   | consistency | `tryApply()` uses `console.log` for its error path (soft warning), not `console.warn`                                                                                                                            | `cli/index.ts:548`                                 | trivial |
| Z09-11 | medium   | complexity  | `BuilderScreen.tsx` is 715 lines — `StepContentProps` interface with 8 ref parameters could be consolidated                                                                                                      | `tui/screens/BuilderScreen.tsx:370-382`            | small   |
| Z09-12 | medium   | naming      | `healthWord()` in `cli/index.ts` and `healthGlyph()` in `tui/ui/theme.ts` are parallel implementations of the same connector health mapping                                                                      | `cli/index.ts:110`, `tui/ui/theme.ts:14`           | small   |
| Z09-13 | medium   | dependency  | `ink`, `ink-text-input`, and `react` are in `dependencies` (not `devDependencies`), which means the production server bundle carries TUI deps                                                                    | `apps/agent/package.json`                          | small   |
| Z09-14 | medium   | security    | `sym secret` TUI accepts a secret value as a positional CLI arg (`args[3]`), which will appear in shell history and `ps aux`                                                                                     | `cli/index.ts:572`                                 | small   |
| Z09-15 | low      | dead-code   | `useCallback` imported in `SecretsManager.tsx` but the `loadData` pattern does not actually need it (the array dependency is empty)                                                                              | `tui/screens/SecretsManager.tsx:18`                | trivial |
| Z09-16 | low      | type-safety | `response.json() as Promise<T>` casts in `admin-client.ts` bypass runtime shape validation                                                                                                                       | `cli/admin-client.ts:100,126,149`                  | small   |
| Z09-17 | low      | complexity  | `SummaryLine` in `BuilderScreen.tsx` uses a parallel `order: SummaryUpTo[]` array with index-arithmetic to decide what to render — brittle ordering logic                                                        | `tui/screens/BuilderScreen.tsx:611-638`            | small   |
| Z09-18 | low      | docs        | The README "Repository layout" block only shows `apps/agent` and `docs/` — omits `packages/`, `scripts/`, `assets/`, `dokploy/`, `slack/`, and `dev/`                                                            | `README.md:76-83`                                  | trivial |
| Z09-19 | low      | logging     | `useEffect` in `DetailScreen.tsx` closes over `loadData` but passes `[]` as the dependency array — stale closure will silently stop refreshing if connector changes                                              | `tui/screens/DetailScreen.tsx:71-73`               | trivial |
| Z09-20 | low      | naming      | The `main()` entry guard at `cli/index.ts:676` checks `argv[1] !== undefined && fileURLToPath(...) === argv[1]` — the `argv[1] !== undefined` is defensive noise; `argv[1]` is always a string when running Node | `cli/index.ts:676`                                 | trivial |

---

## Detail

### Z09-01 — critical — TUI SecretsManager directly contradicts the North Star

**Evidence:**

- `README.md:9`: "No database, no dashboard — configured entirely by environment variables."
- `docs/FUTURE.md:9`: The 2026-05-27 collapse explicitly removed "Secrets — libsodium encrypt/decrypt" and "Dashboard — Next.js admin control plane".
- `tui/screens/SecretsManager.tsx`: The screen lists, adds, and deletes static secrets from an encrypted SQLite database (`SqliteCredentialStore`), keyed by `SYM_ENCRYPTION_KEY`.
- `tui/app.tsx:19-21`: `{ name: 'secrets' }` is a named screen in the router.
- `cli/index.ts:666`: `sym secret set|ls|rm` is a documented, working command.

The SecretsManager surface — both the TUI screen and the `sym secret` CLI verbs — is a secrets store. It is not a removed feature; it is fully wired, tested, and in the `bin` distribution. The README and FUTURE.md both claim this functionality was removed.

Whether to keep or remove it hinges on one design question: does the MCP connector feature (which uses `SqliteCredentialStore` for OAuth tokens AND static secrets) justify shipping an encrypted SQLite store? If MCP connectors are in scope (they are — `packages/adapter/slack`, `mcp/`, etc.), then the store is needed for OAuth. The question is whether the **operator-facing management surface** (the `sym secret` verb, the SecretsManager screen) belongs in an "env-configured, no-dashboard" tool.

**Recommendation:**

- If MCP connectors stay (they clearly are), acknowledge the store's existence honestly: remove the "no database" claim from README (it applies to Slack state, not to MCP credentials), or add a footnote that `sym secret` is an optional operator surface for MCP connector auth.
- Separately consider whether the TUI `SecretsManager` screen belongs in an OSS release — a CLI (`sym secret`) is a lower bar than a TUI screen for something the README says does not exist.

---

### Z09-02 — high — `statusColor()` is an exported dead export

**Evidence:**
`tui/ui/theme.ts:21`:

```ts
export function statusColor(status: string): string { ... }
```

`grep -rn "statusColor"` returns only the declaration itself. No screen, test, or other file imports or calls it.

**Recommendation:** Delete the function. If it was intended to color the `ConnectorStatus.status` word in some future detail view, the functionality is better added at the call site when needed.

---

### Z09-03 — high — `fetchStatus()` and `StatusResponse` are never used in production

**Evidence:**
`cli/admin-client.ts:66,111` defines `StatusResponse` and `fetchStatus()`. Neither is imported anywhere in `src/` (only in `tests/cli.admin-client.test.ts`). The `sym status` command uses `fetchConnectors()` instead for richer per-connector data, making `fetchStatus()` obsolete.

**Recommendation:** Remove `fetchStatus()`, `StatusResponse`, and the `/admin/status` route in `server.ts` (separate zone, but the seam is here). If the lightweight status route is desired for health probes, keep the server route but remove the typed client wrapper and document it separately.

---

### Z09-04 — high — `injectValueTemplate` step is missing from the `Step` union type

**Evidence:**
`tui/screens/BuilderScreen.tsx:140-150`:

```ts
type Step =
  | 'name'
  | 'transportKind'
  | 'target'
  | 'args'
  | 'authKind'
  | 'secret'
  | 'injectAt'
  | 'injectParam'
  | 'trust'
  | 'submit';
```

`BuilderScreen.tsx:542`: when `injectAt === 'header'`, the code does:

```ts
setStep('injectValueTemplate' as Step);
```

The `as Step` cast is the suppression. The step is real (line 555 renders it), but it is not in the union, so TypeScript does not enforce exhaustiveness. This also means the step is absent from `StepFooter`'s `textSteps` array (line 646) — the Enter-to-advance hint does not appear during header-value-template entry.

**Recommendation:** Add `'injectValueTemplate'` to the `Step` union; remove the `as Step` cast; add `'injectValueTemplate'` to `StepFooter`'s `textSteps` so the footer hint renders.

---

### Z09-05 — high — `offlineDetails()` is duplicated

**Evidence:**
`cli/index.ts:117-124` and `tui/screens/Dashboard.tsx:33-46` both define a local `offlineDetails()` that maps `loadConfigFile(configPath()).mcpServers` to `ConnectorDetail[]` with `ok: false, tools: 0`. The implementations are functionally identical; the TUI version wraps in a `try/catch` while the CLI version does not.

**Recommendation:** Extract to `cli/admin-client.ts` (or a new `cli/utils.ts`) as a shared helper, and import it in both places. The TUI variant's `try/catch` is the safer form and should be the canonical implementation.

---

### Z09-06 — high — Operator env vars absent from `.env.example` and README

**Evidence:**
`.env.example` documents only: `SLACK_*`, `SYM_OWNER_SLACK_USER_ID`, `FIREWORKS_*`, `AGENT_PORT`, and a few behavior controls. Missing entirely:

| Variable             | Used in                                              |
| -------------------- | ---------------------------------------------------- |
| `SYM_CONFIG_PATH`    | `mcp/source.ts:44`, entire connector wiring system   |
| `SYM_ENCRYPTION_KEY` | `mcp/store.ts:159`, `sym secret` + OAuth tokens      |
| `SYM_DB_PATH`        | `mcp/store.ts:156`, SQLite credential store path     |
| `SYM_ADMIN_URL`      | `cli/admin-client.ts:36`, `sym` CLI admin override   |
| `SYM_CLI_ALLOWLIST`  | `run-cli.ts:68`, which binaries the agent can run    |
| `SYM_CLI_CONFIRM`    | `pi/loop.ts:562`, gate before each run_cli execution |

An OSS newcomer deploying with MCP connectors will hit SYM_ENCRYPTION_KEY errors with no guidance.

**Recommendation:** Add a commented "## MCP connectors / sym CLI" section to `.env.example` documenting all six variables. Update the README env-var table similarly.

---

### Z09-07 — high — TUI tests are mocked-unit, not real-wire

**Evidence:**
All five TUI test files (`tests/tui.*.test.tsx`) use `ink-testing-library` with `vi.mock()` for `admin-client`, `config-store`, and `mcp/source`. No test drives the actual `sym` binary against a live agent or exercises the real `SqliteCredentialStore`. The team convention (`MEMORY.md` "QA-testable, no broken ship") requires real-wire integration tests via real subprocess or local server for every real feature.

The CLI command tests (`tests/cli.commands.test.ts`) correctly use a real `createServer()` and loopback socket — TUI tests should follow the same pattern for at least the `sym status` / `sym connector ls` happy paths.

**Recommendation:** Add at minimum one real-wire smoke test per TUI screen that launches a real agent server and exercises the admin HTTP routes. The existing `cli.commands.test.ts` structure is the correct model.

---

### Z09-08 — medium — Dashboard contradicts "no-dashboard" framing

**Evidence:**

- `README.md:9`: "No database, no dashboard"
- `tui/screens/Dashboard.tsx`: A full interactive TUI dashboard with live health polling every 3 seconds, cursor navigation, apply/test/add/remove/secrets actions.
- `cli/index.ts:621`: `sym` on a TTY launches the TUI; it is a first-class surface.

The Dashboard itself is well-implemented and genuinely useful for an operator managing MCP connectors. The problem is the disconnect between what the product says it is and what it ships. For OSS clarity, either the README framing must change ("no web dashboard") or the TUI must be removed/extracted.

**Recommendation:** Update the README to say "no web dashboard" instead of "no dashboard." The TUI is a CLI operator tool, not a web UI — that distinction is worth preserving explicitly.

---

### Z09-09 — medium — `cli/index.ts` console.log usage is undocumented as a deliberate exception

**Evidence:**
`cli/index.ts` uses `console.log` 50+ times for operator output (command results, JSON, table rows). The team convention is "server boot/runtime logs must use `console.info/warn`, NEVER `console.log`" because tests spy on `console.log`. This is legitimate for a non-server CLI binary — `console.log` is the correct channel for operator-facing output — but the convention document is phrased as universal, not server-scoped.

**Recommendation:** Add a comment at the top of `cli/index.ts` noting that `console.log` is intentional here (operator-facing CLI output), and update the convention to explicitly scope the `console.log` prohibition to server/daemon code only.

---

### Z09-10 — medium — `tryApply()` error path uses `console.log` instead of `console.warn`

**Evidence:**
`cli/index.ts:548`:

```ts
} catch (err) {
  console.log(
    `(config written; not applied — ${...}. It will take effect on agent start...)`,
  );
}
```

This is a soft warning (config saved but agent unreachable), which is more appropriately a `console.warn`. The parenthetical formatting also obscures that this is an error state.

**Recommendation:** Change to `console.warn` and remove the parenthetical wrapping to make the diagnostic clearer.

---

### Z09-11 — medium — `StepContentProps` passes 8 individual refs as separate props

**Evidence:**
`tui/screens/BuilderScreen.tsx:370-382`:

```ts
interface StepContentProps {
  step: Step;
  state: BuilderState;
  setState: React.Dispatch<React.SetStateAction<BuilderState>>;
  nameRef: React.MutableRefObject<string>;
  targetRef: React.MutableRefObject<string>;
  argsRef: React.MutableRefObject<string>;
  secretRef: React.MutableRefObject<string>;
  injectParamRef: React.MutableRefObject<string>;
  injectValueTemplateRef: React.MutableRefObject<string>;
  setStep: (s: Step) => void;
}
```

Ten props total. The six `*Ref` fields are a single logical concept (the set of input refs). Grouping them reduces the blast radius of adding new form fields.

**Recommendation:** Consolidate the refs into a single `refs` object prop:

```ts
refs: {
  name: React.MutableRefObject<string>;
  target: React.MutableRefObject<string>;
  args: React.MutableRefObject<string>;
  secret: React.MutableRefObject<string>;
  injectParam: React.MutableRefObject<string>;
  injectValueTemplate: React.MutableRefObject<string>;
}
```

This is a cosmetic improvement; it does not affect correctness.

---

### Z09-12 — medium — Parallel health-mapping implementations: `healthWord()` and `healthGlyph()`

**Evidence:**
`cli/index.ts:110`:

```ts
function healthWord(d: { ok: boolean; error?: string }): string {
  if (d.ok) return 'connected';
  if (d.error !== undefined) return 'failed';
  return 'down';
}
```

`tui/ui/theme.ts:14`:

```ts
export function healthGlyph(d: { ok: boolean; error?: string }): { glyph: string; color: string } {
  if (d.ok) return { glyph: '●', color: COLORS.ok };
  if (d.error !== undefined) return { glyph: '⚠', color: COLORS.warn };
  return { glyph: '○', color: COLORS.dim };
}
```

These implement the same three-state health classification with different outputs. They are naturally parallel (text vs glyph+color) and need not be merged, but they define the canonical health states in two separate files with no shared contract. A new health state (e.g. "connecting") must be added in both.

**Recommendation:** Define a shared `type ConnectorHealth = 'connected' | 'failed' | 'down'` in `cli/admin-client.ts` or `mcp/index.ts`, then base both `healthWord` and `healthGlyph` on it. This makes the three-state contract explicit and single.

---

### Z09-13 — medium — `ink`, `react`, `ink-text-input` in production dependencies

**Evidence:**
`apps/agent/package.json` lists `ink`, `ink-text-input`, and `react` in `dependencies` (not `devDependencies`). These packages are only needed when running the `sym` CLI TUI — they are never used by the Hono server, the Pi agent loop, or any Slack processing. They add ~6 MB to the production node_modules that the server image installs.

**Recommendation:** Move `ink`, `ink-text-input`, `react`, `@types/react`, and `ink-testing-library` to `devDependencies`. The `sym` CLI binary uses `tsx` in dev (`"sym": "tsx src/cli/index.ts"`) and the compiled dist in prod — both work fine with devDependencies when the package is not published to npm as a library. If the sym binary is installed globally from npm, a separate package is the right answer; until then, moving to devDependencies reduces the deploy image size.

---

### Z09-14 — medium — `sym secret set` accepts the secret value as a CLI arg (shell history exposure)

**Evidence:**
`cli/index.ts:572`:

```ts
const value = args[3] ?? (await readStdin());
```

When `args[3]` is provided (e.g. `sym secret set sentry TOKEN abc123`), the secret value appears in shell history, `ps aux`, and any process-list observers. The `readStdin()` fallback is the safe path, but the code actively offers the unsafe arg form.

**Recommendation:** Remove the `args[3]` fallback so secrets can only be provided via stdin (or a future `--file` flag). Update the help text accordingly: `sym secret set <connector> <field>` — value via stdin. The `setSecret()` in `cli/secrets.ts` already accepts the value as a parameter so this only changes the CLI argument parsing.

---

### Z09-15 — low — `useCallback` import in `SecretsManager.tsx` not needed

**Evidence:**
`tui/screens/SecretsManager.tsx:18`:

```ts
import React, { useCallback, useEffect, useRef, useState } from 'react';
```

`loadData` on line 200 is wrapped with `useCallback([], [...])` where the dependency array is `[]`. Because it never changes, wrapping in `useCallback` adds no value — a plain function or `useRef` would be clearer. The `useRef` refs (connectorRef, fieldRef, valueRef) declared in `AddFlow` on lines 68-70 are never used at call-site outside of `AddFlow` itself, making the import unused at the `SecretsManager` level.

**Recommendation:** Remove `useCallback` from the import and unwrap `loadData` to a plain function (or lift it once with `useRef` if memoisation is truly needed). Minor cleanup only.

---

### Z09-16 — low — `response.json() as Promise<T>` casts bypass runtime validation

**Evidence:**
`cli/admin-client.ts:100`:

```ts
return response.json() as Promise<ReloadResponse>;
```

Similarly on lines 126 and 149. `fetch().json()` returns `Promise<unknown>`; the cast gives it a typed shape without any runtime check. If the server returns an unexpected shape (e.g. an error body that is not JSON, or a shape mismatch after a server refactor), callers receive a typed object that silently has undefined fields.

**Recommendation:** Use `response.json() as Promise<T>` only when the server contract is tightly locked (it is here — `createServer` is in the same package). Add a one-line comment acknowledging the trust: `// server is co-located; shape is guaranteed by contract`. Or use a lightweight `zod` parse at the boundary for the two most critical responses (`ReloadResponse`, `ConnectorDetail[]`). Either is an improvement over the current cast-without-comment.

---

### Z09-17 — low — `SummaryLine` uses fragile index-arithmetic over a parallel order array

**Evidence:**
`tui/screens/BuilderScreen.tsx:611-638`:

```ts
const order: SummaryUpTo[] = [
  'name',
  'transportKind',
  'target',
  'args',
  'authKind',
  'secret',
  'injectAt',
  'injectParam',
  'trust',
];
const idx = order.indexOf(upTo);
if (idx >= 0 && state.name.length > 0) parts.push(`name: ${state.name}`);
if (idx >= 1) parts.push(`transport: ${state.transportKind}`);
// ...
```

The mapping of index to summary field is implicit. Adding or reordering a step requires updating both `order` and the numbered `if (idx >= N)` guards. The `injectValueTemplate` step (missing from `Step`) also has no entry here.

**Recommendation:** Replace with an explicit predicate array or a `Set`-based check:

```ts
const shown = new Set(order.slice(0, order.indexOf(upTo) + 1));
if (shown.has('name') && state.name.length > 0) parts.push(`name: ${state.name}`);
```

This makes the show-condition explicit and adding a step is a two-line change.

---

### Z09-18 — low — README repo layout is incomplete

**Evidence:**
`README.md:76-83`:

```
apps/
  agent/    Hono server …
docs/
  FUTURE.md …
```

The actual repo root contains: `packages/` (adapter/slack, contracts, kernel), `scripts/`, `assets/`, `dokploy/`, `slack/`, `dev/` (gitignored provisioning), `docker-compose.yml`, and `Dockerfile`. A contributor cloning the repo sees none of these in the README.

**Recommendation:** Expand the layout block to list all top-level directories with a one-line description. The `docs/FUTURE.md` is especially misleading — it implies the parked features are not present, but `sym secret`, `SqliteCredentialStore`, and the TUI all contradict that.

---

### Z09-19 — low — `DetailScreen.tsx` useEffect has empty dependency array with stale `loadData`

**Evidence:**
`tui/screens/DetailScreen.tsx:71-73`:

```ts
useEffect(() => {
  loadData();
}, []);
```

`loadData` is defined as a plain function inside the component body on line 39, which closes over `connector`, `setReachable`, `setDetail`, `setTools`, `setConfig`. ESLint's `react-hooks/exhaustive-deps` rule would flag `loadData` as a missing dependency. In practice, because `connector` (a `string`) never changes between renders in this mounted component (the detail screen receives it as a prop from the router), this is a benign stale closure — but it is a lint violation and the pattern is fragile.

**Recommendation:** Wrap `loadData` with `useCallback([connector])` and include it in the `useEffect` dep array, or inline the function body into the effect. The `useCallback` pattern used in `SecretsManager.tsx` is the right model.

---

### Z09-20 — low — Defensive `argv[1] !== undefined` guard is unnecessary noise

**Evidence:**
`cli/index.ts:676`:

```ts
if (argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1]) {
```

`process.argv[1]` is always a string (the script path) when Node executes any module as an entry point. The `!== undefined` check is defensive noise that adds no safety. The `argv` import on line 35 is typed as `string[]` anyway.

**Recommendation:** Remove the `argv[1] !== undefined &&` guard, leaving:

```ts
if (fileURLToPath(import.meta.url) === argv[1]) {
```

---

## Proposed chunks

Dependency-ordered refactor chunks for Zone Z09 — each delivers one working thing.

### Chunk 1 — Kill the dead exports (Z09-02, Z09-03, Z09-15, Z09-20)

**Goal:** Remove `statusColor()`, `fetchStatus()`, `StatusResponse`, the unused `useCallback` in SecretsManager, and the redundant `argv[1] !== undefined` guard. Build stays green, tests stay passing. Zero functional change.

**Depends on:** nothing.
**Finding IDs:** Z09-02, Z09-03, Z09-15, Z09-20.

---

### Chunk 2 — Fix `Step` type and `injectValueTemplate` step (Z09-04)

**Goal:** Add `'injectValueTemplate'` to the `Step` union in `BuilderScreen.tsx`, remove the `as Step` cast, and add the missing footer hint. All existing `BuilderScreen` tests still pass; the header-injection flow gains a proper step.

**Depends on:** nothing.
**Finding IDs:** Z09-04.

---

### Chunk 3 — Deduplicate `offlineDetails()` (Z09-05)

**Goal:** Extract the canonical `offlineDetails()` helper to `cli/admin-client.ts` (with the try/catch form), remove the two local copies, and import it in both `cli/index.ts` and `Dashboard.tsx`. All tests pass.

**Depends on:** nothing.
**Finding IDs:** Z09-05.

---

### Chunk 4 — Fix `tryApply` warning level and document `console.log` intent (Z09-09, Z09-10)

**Goal:** Change `tryApply()`'s catch to `console.warn`. Add a module-level comment to `cli/index.ts` documenting that `console.log` is intentional (operator output channel). Update the team convention scope to "server/daemon code only."

**Depends on:** nothing.
**Finding IDs:** Z09-09, Z09-10.

---

### Chunk 5 — Remove secret-as-arg; stdin only (Z09-14)

**Goal:** Remove the `args[3]` path in `secretCommand`. Update help text. Update `cli.secrets.test.ts` to verify the stdin-only path. Build green; secrets no longer appear in shell history.

**Depends on:** nothing.
**Finding IDs:** Z09-14.

---

### Chunk 6 — Document operator env vars in `.env.example` and README (Z09-06, Z09-18, Z09-08)

**Goal:** Add a commented MCP/CLI section to `.env.example` with all six undocumented env vars. Expand the README layout block to reflect the actual repo structure. Update "no dashboard" → "no web dashboard." This is a docs-only chunk.

**Depends on:** nothing.
**Finding IDs:** Z09-06, Z09-08, Z09-18.

---

### Chunk 7 — Define shared `ConnectorHealth` type; unify `healthWord`/`healthGlyph` (Z09-12)

**Goal:** Add a `type ConnectorHealth = 'connected' | 'failed' | 'down'` to `cli/admin-client.ts` (or `mcp/index.ts`). Refactor `healthWord()` in `cli/index.ts` and `healthGlyph()` in `tui/ui/theme.ts` to both use it. The three-state classification is now single-source.

**Depends on:** Chunk 3 (admin-client is the target location).
**Finding IDs:** Z09-12.

---

### Chunk 8 — Move ink/react to devDependencies (Z09-13)

**Goal:** Move `ink`, `ink-text-input`, `react`, `@types/react`, `ink-testing-library` from `dependencies` to `devDependencies` in `apps/agent/package.json`. Verify `pnpm build` and `pnpm test` still pass. The production server image shrinks.

**Depends on:** nothing (pure package.json change).
**Finding IDs:** Z09-13.

---

### Chunk 9 — Consolidate `StepContentProps` refs and fix `SummaryLine` (Z09-11, Z09-17)

**Goal:** Merge the six individual ref props in `StepContentProps` into a single `refs` object. Replace the index-arithmetic in `SummaryLine` with an explicit set-based check. Add `injectValueTemplate` to the summary order (depends on Chunk 2). Tests pass; BuilderScreen is ~30 lines shorter.

**Depends on:** Chunk 2.
**Finding IDs:** Z09-11, Z09-17.

---

### Chunk 10 — Add real-wire smoke tests for TUI/CLI flows (Z09-07)

**Goal:** Add one real-wire integration test per major TUI flow (dashboard poll, connector add via CLI, sym status) that starts a real `createServer()` with a loopback socket. Follow the `cli.commands.test.ts` pattern. TUI screens exercised through the CLI binary rather than ink-testing-library mocks.

**Depends on:** Chunks 3, 4, 5 (stable CLI surface before adding real-wire tests).
**Finding IDs:** Z09-07.

---

### Chunk 11 — Reconcile North Star framing: acknowledge the secrets store (Z09-01)

**Goal:** Update `README.md` and `docs/FUTURE.md` to accurately reflect that Sym ships an optional SQLite credential store (`mcp/store.ts`) for MCP OAuth tokens and static secrets — not a "database" in the original removed sense, but a real on-disk store. Remove or qualify the "no database" claim. If the team decides the TUI SecretsManager and `sym secret` verbs do not belong in an OSS release, delete them in this chunk.

**Depends on:** Chunk 6 (docs already updated), Chunk 5 (secure secret CLI first).
**Finding IDs:** Z09-01.
