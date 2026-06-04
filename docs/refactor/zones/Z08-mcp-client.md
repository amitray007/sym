# Zone Z08: MCP client subsystem

## Summary

The MCP client subsystem (`apps/agent/src/mcp/`) is the newest, most complete, and best-documented zone in the codebase. The three-axis model (transport × acquisition × injection) is clean and explicit; parsing is fail-open with good warning messages; the security invariant (force `destructiveHint:true` unless owner opts in via `trust`) is sound and consistently explained. The CompositeDispatcher seam is minimal and correct.

Several structural problems reduce the zone's quality for OSS readers. The biggest is an **architectural tension with the North Star**: the `SqliteCredentialStore` backed by `node:sqlite` (an unstable experimental API) introduces persistent state that directly contradicts the "no database, stateless" claim in the README — this is an intentional and necessary trade-off for OAuth, but it is not acknowledged anywhere in the README or the zone-level doc comment, which will confuse first-time readers. The `tools.allow` field is **parsed, documented, and stored but never enforced** — a silent no-op that misleads operators. The `source.ts` module has two responsibilities (MCP connector loading _and_ CLI config loading), causing layering bleed, repeated `readFileSync` calls per turn, and exports that bypass `index.ts`. There are several dead or stub exports that pollute the public surface (`CredentialProvider.refresh`, `SdkOAuthAdapter.invalidateCredentials`). The TUI-facing section-header comment in `dispatcher.ts` still references a TUI that the North Star forbids. Minor issues include a hand-rolled `timingSafeEqual` when `node:crypto.timingSafeEqual` is already imported, a dummy `new Client(...)` created on error paths that is never used, and `source.ts` being read up to three times per run-cli invocation.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                                                   | Files                                                        | Effort  |
| ------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| Z08-01 | high     | structure   | `tools.allow` parsed and stored but never enforced                                                                                                                      | `mcp/config.ts:102`, `mcp/dispatcher.ts:196`                 | small   |
| Z08-02 | high     | structure   | `source.ts` owns two unrelated responsibilities (MCP config + CLI config)                                                                                               | `mcp/source.ts:83-134`                                       | medium  |
| Z08-03 | high     | docs        | North Star "no database" claim contradicts SQLite credential store (never reconciled)                                                                                   | `README.md:4,17`, `mcp/store.ts:1-16`                        | trivial |
| Z08-04 | medium   | dead-code   | `CredentialProvider.refresh?()` declared but never called                                                                                                               | `mcp/providers/provider.ts:51`, `mcp/providers/oauth.ts:248` | trivial |
| Z08-05 | medium   | dead-code   | `SdkOAuthAdapter.invalidateCredentials` is a documented stub that silently no-ops for `tokens` scope                                                                    | `mcp/providers/oauth.ts:182-196`                             | small   |
| Z08-06 | medium   | security    | Hand-rolled `timingSafeEqual` instead of `node:crypto.timingSafeEqual`                                                                                                  | `mcp/oauth-registry.ts:123-133`                              | trivial |
| Z08-07 | medium   | structure   | `loadCliAllow` / `loadCliDescribe` not exported from `mcp/index.ts`; callers reach into internals                                                                       | `mcp/index.ts:3-4`, `run-cli.ts:20`, `cli/index.ts:56`       | trivial |
| Z08-08 | medium   | performance | `source.ts` config file read up to 3× per `resolveCliCapabilities` call (no caching)                                                                                    | `mcp/source.ts:85-101`, `run-cli.ts:66,85-86,128`            | small   |
| Z08-09 | medium   | ai-slop     | TUI-facing section comment persists in `dispatcher.ts` after TUI was removed                                                                                            | `mcp/dispatcher.ts:527`                                      | trivial |
| Z08-10 | medium   | complexity  | `dispatcher.ts` (652 lines) mixes pool management, reconcile, introspection, and test helpers in one file                                                               | `mcp/dispatcher.ts`                                          | medium  |
| Z08-11 | low      | dead-code   | `PoolEntry.client` populated with a dummy `new Client(...)` in error paths that is never used                                                                           | `mcp/dispatcher.ts:237,259`                                  | trivial |
| Z08-12 | low      | structure   | `config.ts` `tools.allow` doc says "Stored; enforcement optional" — this hides a silent no-op from operators                                                            | `mcp/config.ts:102`                                          | trivial |
| Z08-13 | low      | type-safety | `rawTool.inputSchema as ToolDescriptor['parameters']` is an unsafe cast; shape is not validated                                                                         | `mcp/dispatcher.ts:201`                                      | small   |
| Z08-14 | low      | type-safety | `CredentialStore` interface not exported from `mcp/index.ts`; external callers (`cli/secrets.ts`) must reach into `mcp/store.ts` directly                               | `mcp/index.ts:24`, `cli/secrets.ts:17`                       | trivial |
| Z08-15 | low      | docs        | `node:sqlite` is experimental in Node 24 — not noted in `store.ts` module doc or README                                                                                 | `mcp/store.ts:4,22`                                          | trivial |
| Z08-16 | low      | config      | Config file `version` field is documented (shape says `{ "version": 1, "mcpServers": [...] }`) but never read or validated in `source.ts`                               | `mcp/source.ts:20,80`                                        | trivial |
| Z08-17 | low      | security    | HTTP transport URL in `inject.ts` has no SSRF guard — a misconfigured `url` can target internal/loopback services                                                       | `mcp/inject.ts:186,216`                                      | small   |
| Z08-18 | low      | naming      | `OAuthProvider` / `SdkOAuthAdapter` name collision risk — `OAuthProvider` is a public class but `makeOAuthProvider` is also exported; the two names are easy to confuse | `mcp/providers/oauth.ts:213,265`                             | trivial |
| Z08-19 | low      | consistency | `server.ts` and `run-cli.ts` bypass `mcp/index.ts` for several imports (`oauth-registry`, `source`) while `cli/index.ts` bypasses for `source`                          | `server.ts:23-24`, `run-cli.ts:20`, `cli/index.ts:56`        | trivial |
| Z08-20 | low      | testing     | `completeOAuth` CSRF-race path (delete-before-finishAuth) and OAuth connector retry-after-auth are not covered by unit tests                                            | `mcp/oauth-registry.ts:104`, `mcp/dispatcher.ts:278`         | medium  |

---

## Detail

### Z08-01 — `tools.allow` parsed and stored but never enforced (HIGH)

**Evidence.** `config.ts:102` defines the field and marks it _"Stored; enforcement optional"_. `dispatcher.ts:196` maps `rawTools.map(...)` with no filter — the full tool list from the server is always used, regardless of `config.tools?.allow`.

```ts
// mcp/config.ts:102
/** Optional allowlist of tool names to expose from this server. Stored; enforcement optional. */
tools?: { allow?: string[] };
```

The `connectServer` function at `dispatcher.ts:193-206` does not reference `config.tools` at all.

**Impact.** An operator who writes `"tools": { "allow": ["read_file"] }` will see all tools from the server exposed to the agent, not just `read_file`. This is a silent failure — no warning, no error — that produces unexpected behaviour and erodes trust in the config schema. It is not marked as a stub (unlike `prepare` and `secretRef`), so the reader has no indication it is unimplemented.

**Recommendation.** Either (a) implement the filter in `connectServer` (add one `.filter` after the `.map`), or (b) remove the field from `ConnectorConfig` and the parser entirely if it is not planned. If deferred, at minimum add a `console.warn` in `connectServer` when `config.tools?.allow` is set, mirroring the `prepare` stub gate at `dispatcher.ts:152-155`.

---

### Z08-02 — `source.ts` owns two unrelated responsibilities (HIGH)

**Evidence.** `source.ts` has two distinct sections:

1. Lines 1-82: MCP connector loading — `loadConnectorConfigs`, `configPath`, the fallback-chain logic.
2. Lines 83-143: CLI config loading — `readCliSection`, `loadCliAllow`, `loadCliDescribe`.

The CLI functions are consumed by `run-cli.ts` and `cli/index.ts`, not by anything in `mcp/`. They read the same config file but for a completely different subsystem (the `run_cli` allowlist vs MCP connectors). Both sections call `readFileSync(configPath(), 'utf8')` independently (see Z08-08). Neither `loadCliAllow` nor `loadCliDescribe` is exported from `mcp/index.ts`, so callers import from the internal module path directly (`import { loadCliAllow } from './mcp/source.js'` — run-cli.ts:20, cli/index.ts:56).

**Recommendation.** Extract the CLI-config helpers into a dedicated `config-source.ts` (or a `cli/config.ts`) that both the MCP loader and the run-cli module consume, with a shared `readConfigFile()` primitive to eliminate the duplicate `readFileSync` calls. Export the MCP helpers via `mcp/index.ts`; export the CLI helpers via a non-MCP path.

---

### Z08-03 — North Star "no database" claim contradicts SQLite credential store (HIGH)

**Evidence.** `README.md:4` states _"No database, no dashboard"_; `README.md:17` states _"stateless, no DB"_. `mcp/store.ts:1-16` implements a SQLite-backed credential store for OAuth tokens. The store is an intentional, correct design decision (OAuth tokens must be persisted across process restarts), but the README's categorical claim is no longer accurate.

**Recommendation.** Update `README.md` to qualify: the "no database" claim applies to the _conversation layer_ (the thread is memory); OAuth connectors use an encrypted SQLite credential store on the volume for token persistence. This is a one-sentence clarification that prevents the most common newcomer confusion.

---

### Z08-04 — `CredentialProvider.refresh?()` declared but never called (MEDIUM)

**Evidence.** `provider.ts:51`:

```ts
refresh?(): Promise<ResolvedCredential | null>;
```

`OAuthProvider.refresh()` at `oauth.ts:248` returns `null`. No caller in the codebase calls `.refresh()` (confirmed by grep).

**Recommendation.** Remove `refresh?()` from the `CredentialProvider` interface and from `OAuthProvider`. The doc comment already acknowledges _"the SDK handles token refresh internally"_. Dead interface methods are confusing for contributors.

---

### Z08-05 — `SdkOAuthAdapter.invalidateCredentials` silently no-ops for `tokens` scope (MEDIUM)

**Evidence.** `oauth.ts:182-196`:

```ts
invalidateCredentials(scope: ...): void {
  if (scope === 'all' || scope === 'tokens') {
    // We don't have a deleteTokens method; overwrite with a sentinel is
    // not possible without a type-safe sentinel. Clearing via saveTokens
    // with an obviously expired token is a workaround, but the simplest
    // behavior is to rely on the next connect triggering a new auth flow
    // when tokens() returns undefined. Leave as-is for now.
    // If the store needs clearing, a fresh adapter instance will have no tokens.
  }
  ...
}
```

The `tokens` invalidation does nothing. The comment is honest but the behaviour is wrong: the SDK will call `invalidateCredentials('tokens')` when a 401 is received on a refresh attempt, expecting the old tokens to be purged so the next connect starts fresh. If the method is a no-op, the old (invalid) tokens remain and the refresh loop may cycle indefinitely.

**Recommendation.** Add `deleteTokens(connectorName: string): void` to `CredentialStore`/`SqliteCredentialStore` (a `_delete('tokens')` call). Then implement `invalidateCredentials` properly. Alternatively, implement the comment's own suggestion: save an empty/zero `OAuthTokens` sentinel so `tokens()` returns an obviously-expired value.

---

### Z08-06 — Hand-rolled `timingSafeEqual` instead of `node:crypto.timingSafeEqual` (MEDIUM)

**Evidence.** `oauth-registry.ts:23` already imports `{ randomBytes } from 'node:crypto'`. Lines 123-133 implement a manual constant-time XOR loop:

```ts
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  ...
  for (let i = 0; i < bufA.length; i++) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}
```

`node:crypto.timingSafeEqual` is a C-level constant-time comparison that is the stdlib-blessed approach. The hand-rolled version is functionally correct but harder to audit and deviates from stdlib convention.

**Recommendation.** Replace with `crypto.timingSafeEqual` (import `timingSafeEqual as cryptoTimingSafeEqual` from `'node:crypto'`). The early-exit on length mismatch is fine to keep since `cryptoTimingSafeEqual` requires equal-length buffers.

---

### Z08-07 — `loadCliAllow`/`loadCliDescribe` not exported from `mcp/index.ts` (MEDIUM)

**Evidence.** `mcp/index.ts:3` exports `loadConnectorConfigs` and `configPath` from `source.ts`, but not `loadCliAllow` or `loadCliDescribe`. Callers import these directly from `'./mcp/source.js'` (run-cli.ts:20, cli/index.ts:56), bypassing the intended public surface.

**Recommendation.** Once Z08-02 is resolved (CLI helpers moved out), ensure the public surface is complete. If CLI helpers stay in `source.ts` short-term, export them from `index.ts` to establish a single import seam.

---

### Z08-08 — Config file read up to 3× per `resolveCliCapabilities` call (MEDIUM)

**Evidence.** `source.ts:85-101` calls `readFileSync(configPath(), 'utf8')` independently in `readCliSection()`. Each call to `loadCliAllow()` or `loadCliDescribe()` triggers a fresh file read. In `run-cli.ts`, `resolveCliCapabilities()` calls both `loadCliAllow()` (line 85) and `loadCliDescribe()` (line 86) — two reads per capabilities call. `buildCliCatalog` (called by the meta-tools catalog builder every turn) calls `resolveAllowlist()` (→ `loadCliAllow()`) and `resolveCliCapabilities()` (→ `loadCliAllow()` + `loadCliDescribe()`) — three total reads per catalog build. `loadConnectorConfigs()` is a fourth read in the same `source.ts` module.

**Recommendation.** Add a per-request (or request-scoped) memoization for `readCliSection()`, e.g. cache the last result and invalidate on file mtime change, or simply ensure each invocation path reads the file once and passes the parsed data through.

---

### Z08-09 — TUI-facing section comment in `dispatcher.ts` (MEDIUM)

**Evidence.** `dispatcher.ts:527`:

```ts
// Per-connector introspection (powers the TUI dashboard + detail screens)
```

`dispatcher.ts:536`:

```ts
/** A connector's wiring + live health — one row of the dashboard. */
```

The TUI/dashboard references a removed subsystem (the North Star forbids a TUI). The functions themselves (`listConnectorDetails`, `getConnectorTools`, `testConnector`) are legitimately used by the admin HTTP routes — the comment is misleading, not the code.

**Recommendation.** Update comments to say "powers the `/admin/connectors` + `/admin/connectors/:name/test` admin routes" rather than "TUI dashboard".

---

### Z08-10 — `dispatcher.ts` 652 lines, mixes four concerns (MEDIUM)

**Evidence.** The file contains:

1. Pool management (`pool`, `activeConfigs`, `ensureEntry`, `connectServer`, `initMcpPool`) — lines 83-419.
2. `McpDispatcher` class — lines 301-382.
3. Live reconcile (`reconcileConnectors`) — lines 421-524.
4. Admin introspection (`listConnectorDetails`, `getConnectorTools`, `testConnector`) — lines 526-634.
5. Test helpers (`_resetPoolForTesting`) — lines 638-652.

These four concerns have different callers, different lifecycles, and different change frequencies. The file is 652 lines and growing.

**Recommendation.** Split into: `pool.ts` (pool, `McpDispatcher`, `initMcpPool`), `reconcile.ts` (`reconcileConnectors`), `introspect.ts` (detail/tools/test functions). `index.ts` re-exports everything. Each piece is independently testable.

---

### Z08-11 — Dummy `new Client(...)` on error paths (LOW)

**Evidence.** `dispatcher.ts:237` and `dispatcher.ts:259`:

```ts
return {
  client: client ?? new Client({ name: 'sym', version: '1.0.0' }),
  ...
};
```

In error paths, if `client` is still `undefined`, a brand-new `Client` is constructed solely to satisfy the `PoolEntry` shape — but it is never connected and never used (error entries have `ok: false`, so `McpDispatcher.dispatch` returns immediately without calling `entry.client`). The dummy client is never closed either.

**Recommendation.** Make `PoolEntry.client` optional (`client?: Client`) or use a `null` sentinel. Remove the dummy `new Client(...)` construction on error paths to avoid allocating and leaking an unclosed client object.

---

### Z08-12 — `tools.allow` doc hides the no-op with weasel wording (LOW)

**Evidence.** `config.ts:102`:

```ts
/** Optional allowlist of tool names to expose from this server. Stored; enforcement optional. */
```

The phrase _"enforcement optional"_ is misleading — enforcement is not optional, it is simply not implemented. An OSS user reading this will not know the field does nothing.

**Recommendation.** Until Z08-01 is fixed, replace the doc with: `/** NOT YET ENFORCED — parsed and stored only; all tools from the server are currently exposed regardless of this list. */`

---

### Z08-13 — `rawTool.inputSchema as ToolDescriptor['parameters']` unsafe cast (LOW)

**Evidence.** `dispatcher.ts:201`:

```ts
parameters: rawTool.inputSchema as ToolDescriptor['parameters'],
```

`rawTool.inputSchema` is typed by the MCP SDK as a JSON Schema object, but the cast elides any structural validation. A server with a malformed schema will propagate garbage to the Pi loop without warning.

**Recommendation.** A runtime schema validation here is probably overkill (the Pi loop will simply reject the tool call), but the `as` cast should at minimum be narrowed. Consider validating that `rawTool.inputSchema.type === 'object'` and logging a warning otherwise.

---

### Z08-14 — `CredentialStore` interface not exported from `mcp/index.ts` (LOW)

**Evidence.** `mcp/index.ts:24` exports `SqliteCredentialStore` but not the `CredentialStore` interface. `cli/secrets.ts:17` must import the type directly from `'../mcp/store.js'`:

```ts
import type { CredentialStore, SecretRef } from '../mcp/store.js';
```

This is a minor inconsistency — internal modules should import through the zone's index.

**Recommendation.** Add `export type { CredentialStore } from './store.js'` to `mcp/index.ts`.

---

### Z08-15 — `node:sqlite` experimental warning not documented (LOW)

**Evidence.** `node:sqlite` (used in `store.ts:22`) emits an `ExperimentalWarning` on every process start in Node 24. The module doc at `store.ts:4` mentions `node:sqlite` but does not note the experimental status or that `NODE_NO_WARNINGS=1` (or `process.emitWarning` suppression) may be desired in production. `cli/index.ts:562` acknowledges _"avoids its experimental warning"_ when lazy-loading the store in CLI paths, confirming the team is aware, but there is no equivalent note in the store module itself or in the README.

**Recommendation.** Add a note to the `store.ts` module doc: _"Uses `node:sqlite` (experimental in Node 24). The `ExperimentalWarning` emitted at startup is benign but expected — suppress with `NODE_NO_WARNINGS=1` if desired."_ Also document the `SYM_DB_PATH` and `SYM_ENCRYPTION_KEY` vars in `.env.example`.

---

### Z08-16 — Config file `version` field documented but never read (LOW)

**Evidence.** `source.ts:20` documents the file shape as `{ "version": 1, "mcpServers": [...] }`, and the doc comment at `mcp-setup.md:38` shows `"version": 1` in examples. `source.ts:80` reads only `parsed['mcpServers']` and ignores `parsed['version']` entirely — no version check, no warning on version mismatch.

**Recommendation.** Either (a) validate `version === 1` and warn (not error) on unknown version, or (b) remove `version` from the documented shape and examples since it serves no purpose.

---

### Z08-17 — HTTP transport URL has no SSRF guard (LOW)

**Evidence.** `inject.ts:186` and `inject.ts:216` call `new URL(transport.url)` and pass it directly to `StreamableHTTPClientTransport`. There is no check that the URL scheme is `https` or that the hostname is not a loopback/private address. A misconfigured or compromised config file with `"url": "http://169.254.169.254/latest/meta-data/"` (AWS metadata) or `"url": "http://127.0.0.1:5432/"` (internal Postgres) would silently forward tool calls there.

**Context.** The admin routes already have a loopback-only guard. The MCP connector URL is operator-configured (not user-provided), so the attack surface is smaller — but given this is an OSS project, documenting the absence of a guard is important.

**Recommendation.** Add a URL scheme check (`https` required for remote servers) and optionally a hostname validation that warns (not errors) on private-range IPs. Alternatively, document the absence and note that operators are responsible for trusting `SYM_MCP_SERVERS`/config file contents.

---

### Z08-18 — `OAuthProvider` / `makeOAuthProvider` name confusion (LOW)

**Evidence.** `oauth.ts` exports both `class OAuthProvider` (line 213) and `function makeOAuthProvider` (line 265). The dispatcher imports `makeOAuthProvider` but _also_ imports `type OAuthProvider` (line 34 of `dispatcher.ts`). These are the class and its factory, which is idiomatic, but the naming is slightly inconsistent with the rest of the zone where `makeProvider` is the factory for `StaticProvider` and `OAuthProvider` combined. An OSS reader might confuse `OAuthProvider` (the class) with the OAuth flow concept more broadly.

**Recommendation.** Minor: consider renaming `OAuthProvider` to `OAuthCredentialProvider` to match the zone's `CredentialProvider` interface naming pattern, and rename the factory to `makeOAuthCredentialProvider` for parity with `makeProvider`. Not urgent.

---

### Z08-19 — Direct internal imports bypass `mcp/index.ts` (LOW)

**Evidence.** Three production files import from internal MCP module paths instead of going through `mcp/index.ts`:

- `server.ts:23`: `import { completeOAuth } from './mcp/oauth-registry.js'`
- `server.ts:24`: `import { loadConnectorConfigs } from './mcp/source.js'`
- `run-cli.ts:20`: `import { loadCliAllow, loadCliDescribe } from './mcp/source.js'`
- `cli/index.ts:56`: `import { configPath, loadCliDescribe } from '../mcp/source.js'`

`server.ts` imports `completeOAuth` directly instead of through `index.ts` (it is already exported from `index.ts:23`). `loadCliAllow`/`loadCliDescribe` are not in `index.ts` (Z08-07), forcing the direct imports.

**Recommendation.** Export `completeOAuth` is already in `index.ts` — fix `server.ts` line 23 to use `mcp/index.js`. Resolve Z08-07 for the CLI helpers.

---

### Z08-20 — OAuth CSRF-race and retry-after-auth paths lack unit test coverage (LOW)

**Evidence.** `oauth-registry.ts:104` deletes the entry _before_ awaiting `finishAuth` to prevent replay — the comment says _"Single-use: remove BEFORE awaiting finishAuth so a concurrent call with the same state also fails (replay protection)"_. There is no test that exercises a concurrent second call arriving after delete-but-before-finishAuth. Similarly, `dispatcher.ts:278` has a comment _"Non-oauth failures stay cached to avoid per-turn retry storms against a genuinely-down server"_ with a special OAuth retry path — no test covers this path (OAuth connector that was down, tokens stored, then retry succeeds). `mcp.oauth.integration.test.ts` covers the happy path and basic error paths but not these edge cases.

**Recommendation.** Add targeted unit tests for: (1) concurrent `completeOAuth` calls with the same state (both should fail or only one succeeds); (2) OAuth connector retry: pool entry `ok:false` at turn 1, tokens written externally, `ok:true` at turn 2.

---

## Proposed chunks

### C1 — Fix `tools.allow` enforcement or remove the field

**Goal:** Operators who set `tools.allow` get the behaviour the schema promises — or the field is removed and docs updated.

**Finding IDs:** Z08-01, Z08-12

**Depends on:** nothing

**Work:** In `connectServer`, after the `rawTools.map(...)` at `dispatcher.ts:196`, add:

```ts
const filtered =
  config.tools?.allow !== undefined
    ? tools.filter((t) => {
        const local = t.name.slice(config.name.length + MCP_TOOL_SEPARATOR.length);
        return config.tools!.allow!.includes(local);
      })
    : tools;
```

Update `config.ts:102` doc. Add a test in `mcp.test.ts`.

---

### C2 — Extract CLI-config helpers out of `mcp/source.ts`

**Goal:** `mcp/source.ts` has exactly one responsibility: loading MCP connector configs. CLI helpers live in a neutral `config-file.ts` or `cli/config.ts`.

**Finding IDs:** Z08-02, Z08-07, Z08-08, Z08-19 (partial)

**Depends on:** nothing

**Work:** Create `apps/agent/src/config-file.ts` (or `apps/agent/src/cli/config.ts`) with `readConfigFile`, `readCliSection`, `loadCliAllow`, `loadCliDescribe`. Move the shared `readFileSync` into a single cached call. Update `mcp/source.ts`, `run-cli.ts`, `cli/index.ts` imports. Export the CLI helpers through their new module; export MCP helpers through `mcp/index.ts`.

---

### C3 — Fix `CredentialProvider.refresh` and `invalidateCredentials` (dead/stub cleanup)

**Goal:** No dead interface methods in the public surface; token invalidation actually purges tokens.

**Finding IDs:** Z08-04, Z08-05, Z08-14

**Depends on:** nothing

**Work:** Remove `refresh?()` from `CredentialProvider` and `OAuthProvider`. Add `deleteTokens(connectorName: string): void` to `CredentialStore` and implement it in `SqliteCredentialStore`. Implement `invalidateCredentials('tokens')` in `SdkOAuthAdapter`. Export `CredentialStore` type from `mcp/index.ts`.

---

### C4 — Replace hand-rolled `timingSafeEqual` + fix dummy client allocation

**Goal:** Use stdlib crypto for CSRF comparison; remove the dead `new Client(...)` on error paths.

**Finding IDs:** Z08-06, Z08-11

**Depends on:** nothing

**Work:** In `oauth-registry.ts`, import `timingSafeEqual as cryptoTimingSafeEqual` from `'node:crypto'` and replace the hand-rolled loop. In `dispatcher.ts`, make `PoolEntry.client` optional (`client?: Client`) and remove the `client ?? new Client(...)` fallback on error paths (just omit the field).

---

### C5 — Split `dispatcher.ts` into focused modules

**Goal:** `dispatcher.ts` ≤ 300 lines; pool management, reconcile, and introspection are independently navigable.

**Finding IDs:** Z08-10, Z08-09

**Depends on:** nothing (but easier after C4 reduces noise)

**Work:** Create `mcp/pool.ts` (pool Map, `connectServer`, `ensureEntry`, `McpDispatcher`, `initMcpPool`, `_resetPoolForTesting`), `mcp/reconcile.ts` (`reconcileConnectors`, `ReconcileResult`, `ConnectorStatus`), `mcp/introspect.ts` (`listConnectorDetails`, `getConnectorTools`, `testConnector`, `ConnectorDetail`, `ToolInfo`, `ConnectorTestResult`). Update `mcp/index.ts` re-exports and all callers. Update comments to reference admin routes, not TUI.

---

### C6 — README, docs, and config hygiene pass

**Goal:** The README accurately describes what Sym stores (and why); `version` field is either validated or removed; `node:sqlite` experimental status is documented.

**Finding IDs:** Z08-03, Z08-15, Z08-16

**Depends on:** nothing

**Work:** Update `README.md` to qualify the "no DB" claim for OAuth. Add `version` validation (or remove it from docs + examples). Add experimental-warning note to `store.ts` module doc and `.env.example`.

---

### C7 — SSRF guard for HTTP transport URLs (security hardening)

**Goal:** HTTP connector URLs that target private/loopback addresses are rejected or warned on at parse or connect time.

**Finding IDs:** Z08-17

**Depends on:** nothing

**Work:** In `config.ts` `parseTransport` (http branch) or in `inject.ts` `buildHttpTransport`, add a URL validation step: require `https:` scheme for non-localhost URLs; warn on `127.0.0.1`, `::1`, RFC-1918 ranges (`10.`, `172.16-31.`, `192.168.`), and AWS metadata (`169.254.169.254`). Fail-closed (throw) or fail-open with a warning depending on risk tolerance.
