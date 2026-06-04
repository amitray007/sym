# Zone Z08 Supplement: MCP subsystem — unexamined files

This document closes the gap identified by the completeness critic: the original Z08 report
examined only ~4 of ~13 `mcp/` files and produced no findings for the three largest ones
(`composite.ts`, `materialize.ts`, `providers/static.ts`). The four files that DID receive
a Z08 pass (`oauth.ts`, `oauth-registry.ts`, `inject.ts`, `dispatcher.ts`) are re-examined
here at higher resolution; several new findings emerged.

Finding IDs continue from Z08-20 (original Z08 ended there).

---

## Summary of new findings

| ID     | Severity | Category       | Title                                                                                                                                                                                  | Files                                                     | Effort  |
| ------ | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------- |
| Z08-21 | high     | dead-code      | `McpDispatcher.listAsync()` defined but never called — dead method outside `ToolDispatcher` contract                                                                                   | `mcp/dispatcher.ts:304`                                   | trivial |
| Z08-22 | high     | error-handling | `ensureEntry` replaces the old failed OAuth entry without closing its dummy client                                                                                                     | `mcp/dispatcher.ts:282-284`                               | trivial |
| Z08-23 | medium   | naming         | `StaticProvider.materialize()` always passes the hardcoded string `'connector'` instead of the connector name                                                                          | `mcp/providers/static.ts:120`                             | small   |
| Z08-24 | medium   | dead-code      | `MaterializeResult.cleanup` is returned but the caller immediately discards it as `_cleanup` — temp-dir lifetime relies solely on the exit handler                                     | `mcp/providers/static.ts:118`, `mcp/materialize.ts:32`    | small   |
| Z08-25 | medium   | type-safety    | `ResolvedCredential` native variant types `oauth` as `unknown`, forcing an unsafe `as OAuthClientProvider` cast in `inject.ts`                                                         | `mcp/providers/provider.ts:39`, `mcp/inject.ts:181`       | small   |
| Z08-26 | medium   | config         | `SYM_MCP_CONNECT_TIMEOUT_MS` silently becomes `NaN` on a non-numeric value, disabling the timeout entirely                                                                             | `mcp/dispatcher.ts:53-56`                                 | trivial |
| Z08-27 | low      | structure      | `CompositeDispatcher` is a 41-line file doing only prefix routing — consider inlining into `handle-turn.ts` or renaming to better reflect its role                                     | `mcp/composite.ts`                                        | trivial |
| Z08-28 | low      | dead-code      | `makeSignalHandler` in `materialize.ts` is a factory that is only called once per signal — the factory wrapper is unnecessary                                                          | `mcp/materialize.ts:163`                                  | trivial |
| Z08-29 | low      | security       | `oauth.ts` `makeOAuthProvider` silently falls back to `http://localhost:3000` when `SYM_PUBLIC_URL` is absent — OAuth callbacks in production will point to localhost and never return | `mcp/providers/oauth.ts:270`                              | trivial |
| Z08-30 | low      | consistency    | `_cleanup` discard pattern in `static.ts` is inconsistent with how the materializer cleanup contract is described                                                                      | `mcp/providers/static.ts:118`, `mcp/materialize.ts:28-33` | small   |

---

## Detail

### Z08-21 — `McpDispatcher.listAsync()` defined but never called (HIGH)

**Evidence.** `dispatcher.ts:304`:

```ts
async listAsync(): Promise<ToolDescriptor[]> {
  const results = await Promise.all(this.configs.map((c) => ensureEntry(c)));
  return results.flatMap((entry) => entry.tools);
}
```

The `ToolDispatcher` contract in `@sym/contracts` defines only the synchronous `list()` and
the async `dispatch()`. `listAsync()` is not part of the interface. A full-codebase grep
(`grep -rn "listAsync"`) finds exactly one occurrence — the declaration itself. No caller
calls it, including `handle-turn.ts`, `server.ts`, or any test.

**Impact.** The async eager-connect path for listing tools is completely unreachable. The
synchronous `list()` (which returns only already-pooled tools) is what runs in production.
This means the first call to `list()` after a process start ALWAYS returns an empty array if
`initMcpPool` hasn't already been awaited — the intent of `listAsync` was presumably to
guarantee tools are loaded, but since it's never called, this guarantee is never exercised.
(In practice `initMcpPool` is called before `list()` in `handle-turn.ts`, so there is no
observable bug — but the dead method creates confusion.)

**Recommendation.** Remove `listAsync()`. The correct async warm-up path is the existing
`initMcpPool()` call in `handle-turn.ts`. If an async form is ever needed for a new caller,
add it then.

---

### Z08-22 — `ensureEntry` replaces the old failed OAuth entry without closing its dummy client (HIGH)

**Evidence.** `dispatcher.ts:278-284`:

```ts
if (existing !== undefined && (existing.ok || config.auth?.kind !== 'oauth')) {
  return existing;
}
const entry = await connectServer(config);
pool.set(config.name, entry);
return entry;
```

When an OAuth connector first connects, it fails with `UnauthorizedError` and lands in the
pool with `ok: false`. The failed entry holds a dummy `new Client(...)` (see Z08-11). On
the next turn after the owner completes the OAuth callback, `ensureEntry` reaches
`connectServer` again and writes the new (healthy) entry directly into the pool via
`pool.set(config.name, entry)`. The old dummy client is dereferenced and GC'd without ever
having `close()` called on it.

In `reconcileConnectors` and `testConnector`, every replace-pattern correctly calls
`existing.client.close()` before evicting the entry (e.g. `dispatcher.ts:492`, `dispatcher.ts:608`).
`ensureEntry` is the only place that skips this.

**Impact.** Low severity in practice because the dummy client was never connected and
`close()` on an unconnected `Client` is a no-op. However the inconsistency with
`reconcileConnectors` is a latent defect: if a future change makes `PoolEntry.client`
non-nullable and non-dummy, this path will leak a live transport.

**Recommendation.** Before `pool.set(config.name, entry)` in `ensureEntry`, add:

```ts
if (existing !== undefined) {
  existing.client.close().catch(() => undefined);
}
```

This matches the pattern used in `reconcileConnectors` and `testConnector`.

---

### Z08-23 — `StaticProvider.materialize()` hardcodes `'connector'` instead of connector name (MEDIUM)

**Evidence.** `providers/static.ts:118-121`:

```ts
const { dir, cleanup: _cleanup } = await this.materializer.materialize(
  // Use the inject path's basename as a hint in connector naming
  'connector',
  [{ path: inj.path, content: secret }],
);
```

The first argument to `materialize()` is the `connectorName` used in the temp dir prefix
(`sym-mcp-<connectorName>-`). In `static.ts` it is always the literal string `'connector'`,
producing dirs named `sym-mcp-connector-XXXXX` regardless of which connector created them.

`StaticProvider` is constructed without a connector name (its constructor takes only `auth`
and an optional `Materializer`). The `connectorName` is available in `MakeProviderDeps`
(`provider.ts:74`) but `makeProvider` passes only `deps.materializer` to `StaticProvider`
(`provider.ts:99`), discarding `deps.connectorName`.

**Impact.** Temp dirs created for file-injection connectors all share the same prefix. This
is a debuggability issue (log noise when two connectors use file injection) and a semantic
inaccuracy. There is no functional defect unless an operator runs multiple connectors with
file injection simultaneously and needs to match dirs to connectors.

**Recommendation.** Add an optional `connectorName?: string` parameter to the
`StaticProvider` constructor; pass it from `makeProvider` (`deps?.connectorName`). Use it
as the first argument to `materialize()`, falling back to `'connector'` if absent.

---

### Z08-24 — `MaterializeResult.cleanup` discarded with `_cleanup` — per-connector cleanup never runs (MEDIUM)

**Evidence.** `providers/static.ts:118`:

```ts
const { dir, cleanup: _cleanup } = await this.materializer.materialize(...);
```

The `MaterializeResult` interface (`materialize.ts:28-33`) explicitly documents a `cleanup()`
function intended for the caller to invoke when the temp files are no longer needed:

```ts
export interface MaterializeResult {
  dir: string;
  /** Remove the directory and all files within it. Best-effort on process exit. */
  cleanup(): Promise<void>;
}
```

`StaticProvider.applyFileInjection` receives `cleanup` but aliases it as `_cleanup`
(TypeScript/ESLint convention for "intentionally unused"). The `cleanup` function is never
called, neither at the point where the spawned MCP child process exits nor at the end of the
turn. The temp dir is instead removed only by the module-level process-exit handler in
`materialize.ts`.

`ResolvedCredential` (`provider.ts:38`) carries only `{ apply: 'files'; dir: string; vars: Record<string,string> }`.
There is no `cleanup` field on the resolved credential, so the injector (`inject.ts`) has no
way to pass cleanup responsibility to the caller of `buildTransport`. The dir accumulates
for the process lifetime.

**Impact.** For a long-running Sym process with many turns and file-injection connectors,
temp dirs accumulate in `/dev/shm` (or `os.tmpdir()`) and are only cleaned up on process
exit. On `/dev/shm` (RAM-backed), this is a slow memory leak. On a disk-backed `os.tmpdir()`,
it is a disk leak.

**Recommendation.** Either (a) surface the `cleanup` function through the credential chain —
add `cleanup?(): Promise<void>` to `ResolvedCredential`'s `files` variant, populate it in
`applyFileInjection`, and have the dispatcher call it after the connector child process exits
(harder, requires tracking child lifetime), or (b) the simpler fix: call `cleanup()` after
`buildTransport` completes in `connectServer` (the files are only needed during `client.connect`;
once connected, the child has the FDs open and the path can be unlinked on supported platforms),
then document this lifetime contract clearly.

For option (b), change `applyFileInjection` to return `{ apply: 'files', dir, vars, cleanup }`
(adding `cleanup` to the type) and call it in `connectServer` after `client.connect()` succeeds.

---

### Z08-25 — `ResolvedCredential` native variant types `oauth` as `unknown` (MEDIUM)

**Evidence.** `providers/provider.ts:39`:

```ts
| { apply: 'native'; oauth: unknown } // C3 (SDK OAuthClientProvider)
```

`inject.ts:181` must cast through `unknown` to use it:

```ts
const authProvider = resolved.oauth as OAuthClientProvider;
```

The `unknown` type here was presumably chosen to avoid a circular import between
`provider.ts` and the SDK's `OAuthClientProvider`. However `OAuthClientProvider` is already
imported in `inject.ts` via `'@modelcontextprotocol/sdk/client/auth.js'`, and `SdkOAuthAdapter`
in `oauth.ts` already imports from the same path.

**Impact.** The cast on line 181 is structurally correct (the only path that sets `apply:
'native'` sets `oauth` to an `SdkOAuthAdapter`, which satisfies `OAuthClientProvider`), but
the `as` cast bypasses the type-checker. A future implementation that accidentally passes
the wrong object type would compile silently.

**Recommendation.** Import `OAuthClientProvider` as a type-only import in `provider.ts`:

```ts
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
```

Then change the variant to:

```ts
| { apply: 'native'; oauth: OAuthClientProvider }
```

This eliminates the `as` cast in `inject.ts` entirely.

---

### Z08-26 — `SYM_MCP_CONNECT_TIMEOUT_MS` silently becomes `NaN` on a non-numeric value (MEDIUM)

**Evidence.** `dispatcher.ts:53-56`:

```ts
const CONNECT_TIMEOUT_MS =
  process.env['SYM_MCP_CONNECT_TIMEOUT_MS'] !== undefined
    ? Math.max(1000, Number(process.env['SYM_MCP_CONNECT_TIMEOUT_MS']))
    : DEFAULT_CONNECT_TIMEOUT_MS;
```

`Number('abc')` returns `NaN`. `Math.max(1000, NaN)` returns `NaN`. Node's `setTimeout(fn, NaN)`
treats `NaN` as `0` and fires the timeout callback immediately, before the async work begins.
The result: a non-numeric value for `SYM_MCP_CONNECT_TIMEOUT_MS` silently eliminates the
connect timeout rather than failing loudly or using the default.

**Impact.** On misconfiguration, every `connectServer` call races against a timer that fires
immediately. In practice the `connect + listTools` path almost always wins, but any connector
taking more than a few milliseconds to start will time out spuriously, contributing zero tools
permanently for that process lifetime.

**Recommendation.** Add explicit validation:

```ts
const rawTimeout = process.env['SYM_MCP_CONNECT_TIMEOUT_MS'];
const CONNECT_TIMEOUT_MS = (() => {
  if (rawTimeout === undefined) return DEFAULT_CONNECT_TIMEOUT_MS;
  const n = Number(rawTimeout);
  if (!Number.isFinite(n) || n < 1000) {
    console.warn(
      `[mcp] SYM_MCP_CONNECT_TIMEOUT_MS='${rawTimeout}' is not a valid number ≥1000 — using default ${DEFAULT_CONNECT_TIMEOUT_MS}ms`,
    );
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }
  return n;
})();
```

---

### Z08-27 — `CompositeDispatcher` is a 41-line pass-through, consider inlining (LOW)

**Evidence.** `composite.ts` is 41 lines and does exactly one thing: route tool calls by the
presence of `MCP_TOOL_SEPARATOR` in the tool name. The entire class is:

```ts
list(): ToolDescriptor[] {
  return [...this.builtin.list(), ...this.mcp.list()];
}
dispatch(call, ctx): Promise<ToolResult> {
  if (call.name.includes(MCP_TOOL_SEPARATOR)) return this.mcp.dispatch(call, ctx);
  return this.builtin.dispatch(call, ctx);
}
```

Its only caller is `handle-turn.ts:1016`. It is exported from `mcp/index.ts` but consumed
outside the `mcp/` zone entirely. As a module it adds a file, an import, and a conceptual
seam for very little abstraction benefit.

**Impact.** Not a correctness issue. The file is clean and the naming is accurate. The only
concern is that a contributor looking at `mcp/` might expect to find "the MCP dispatcher's
dispatch logic" here but routing logic is split between this file and `dispatcher.ts`.

**Recommendation.** Low priority. Options: (a) inline into `handle-turn.ts` as a local
`buildDispatcher(builtin, mcp)` helper; (b) keep as-is (the separation is harmless and the
class name `CompositeDispatcher` is idiomatic); (c) rename to `McpRoutingDispatcher` to
better signal its role. Not worth changing in isolation; bundle with Z08-10 (C5) if that
split is done.

---

### Z08-28 — `makeSignalHandler` factory wrapper in `materialize.ts` is needlessly indirect (LOW)

**Evidence.** `materialize.ts:163-170`:

```ts
const makeSignalHandler = () => () => {
  Promise.all([..._activeDirs].map(_removeDir))
    .catch(() => undefined)
    .finally(() => process.exit(130));
};

process.once('SIGINT', makeSignalHandler());
process.once('SIGTERM', makeSignalHandler());
```

`makeSignalHandler` is a factory (`() => <handler function>`) that is called exactly twice
and not stored. The factory pattern here adds no benefit — each call to `makeSignalHandler()`
returns a new closure, but both closures are identical (they reference the same
module-level `_activeDirs`). There is no parameterization over a signal name or any other
value.

**Recommendation.** Replace with a single named function:

```ts
function handleSignal(): void {
  Promise.all([..._activeDirs].map(_removeDir))
    .catch(() => undefined)
    .finally(() => process.exit(130));
}
process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);
```

This is trivially cleaner and easier to read.

---

### Z08-29 — `makeOAuthProvider` silently uses `http://localhost:3000` when `SYM_PUBLIC_URL` is absent (LOW)

**Evidence.** `providers/oauth.ts:270`:

```ts
const resolvedPublicUrl = publicUrl ?? process.env['SYM_PUBLIC_URL'] ?? 'http://localhost:3000';
```

`SYM_PUBLIC_URL` is a required runtime secret for any deployment that uses OAuth connectors —
without it, the `redirect_uri` in the OAuth Authorization Request points to `localhost:3000`,
which will never be reachable by the authorization server's callback. The OAuth flow will
succeed (the authorization server sends the code to localhost), but `completeOAuth` will
never fire, leaving the connector in a permanently pending-auth state.

There is no warning when the fallback is used. The error is silent and hard to diagnose
from the Sym logs alone (the authorize URL logged by `redirectToAuthorization` will contain
`localhost:3000` but operators may not notice).

**Impact.** Medium-severity in production if `SYM_PUBLIC_URL` is accidentally unset after
a deploy. The fallback was presumably added for development convenience (local testing),
which is legitimate — but production should fail loudly, not silently.

**Recommendation.** Emit a `console.warn` when the localhost fallback is used:

```ts
if (publicUrl === undefined && process.env['SYM_PUBLIC_URL'] === undefined) {
  console.warn(
    '[oauth] SYM_PUBLIC_URL is not set — using http://localhost:3000 as the OAuth callback base. ' +
      'OAuth connectors will not work in production without this env var.',
  );
}
```

Alternatively, throw in production environments (`NODE_ENV !== 'development'`) when
`SYM_PUBLIC_URL` is absent and an OAuth connector is configured.

---

### Z08-30 — `_cleanup` discard pattern is inconsistent with `MaterializeResult` contract (LOW)

**Evidence.** See Z08-24 above for the full context. This finding is narrower: even if the
per-connector cleanup leak (Z08-24) were accepted as a deliberate design choice ("rely on
process-exit cleanup"), the code should make the intent explicit. The pattern:

```ts
const { dir, cleanup: _cleanup } = await this.materializer.materialize(...);
```

uses the TypeScript/ESLint `_`-prefix convention to signal "I know this value exists but I
am intentionally not using it." This is misleading — a reader who is not aware of the
`_activeDirs` exit handler would reasonably expect a memory/temp-file leak. There is no
comment explaining why `cleanup` is not called.

**Impact.** Code is harder to read and maintain. Contributes to the confusion with Z08-24.

**Recommendation.** Add a comment inline:

```ts
// cleanup is intentionally omitted here: the materializer's process-exit handler
// (_activeDirs) will remove the dir on process shutdown. If per-connector cleanup
// is needed in future, see Z08-24 for the recommended approach.
const { dir } = await this.materializer.materialize(...);
```

Or extract just `dir` without naming `cleanup` at all (TypeScript's destructuring allows
this: `const { dir } = ...`).

---

## Files reviewed in this supplement

The following files received a full read and line-by-line review for this supplement:

| File                        | Lines | Status                                                                   |
| --------------------------- | ----- | ------------------------------------------------------------------------ |
| `mcp/composite.ts`          | 41    | First review (not covered in Z08)                                        |
| `mcp/materialize.ts`        | 200   | First review (not covered in Z08)                                        |
| `mcp/providers/static.ts`   | 278   | First review (not covered in Z08)                                        |
| `mcp/providers/oauth.ts`    | 276   | Re-review (Z08 pass was thin; 3 new findings)                            |
| `mcp/oauth-registry.ts`     | 144   | Re-review (Z08-06 noted; 0 new findings)                                 |
| `mcp/inject.ts`             | 221   | Re-review (Z08-17 noted; 1 new finding — Z08-25)                         |
| `mcp/dispatcher.ts`         | 652   | Re-review (Z08-09–Z08-13 noted; 2 new findings — Z08-21, Z08-22, Z08-26) |
| `mcp/providers/provider.ts` | 137   | Cross-reference for provider.ts chain                                    |
| `mcp/config.ts`             | 552   | Cross-reference for config shapes                                        |
| `mcp/store.ts`              | 333   | Cross-reference for store interface                                      |
| `mcp/index.ts`              | 26    | Cross-reference for public surface                                       |

## Proposed additional chunks

### C8 — Fix `listAsync` dead method + `ensureEntry` client-leak + `NaN` timeout

**Goal:** Remove the dead `listAsync` method; plug the dummy-client non-close in
`ensureEntry`; fix `SYM_MCP_CONNECT_TIMEOUT_MS` NaN bypass.

**Finding IDs:** Z08-21, Z08-22, Z08-26

**Depends on:** nothing (C11 on Z08-11 would also benefit from this)

**Work:** Delete `McpDispatcher.listAsync()`. Add `existing.client.close().catch(...)` in
`ensureEntry` before `pool.set`. Replace the `Math.max(1000, Number(...))` timeout parse
with explicit `Number.isFinite` validation and a warn fallback.

---

### C9 — Fix `StaticProvider` connector name + cleanup contract

**Goal:** `materialize()` receives the actual connector name; the temp-dir lifetime is
explicit and per-connector cleanup is tracked.

**Finding IDs:** Z08-23, Z08-24, Z08-30

**Depends on:** nothing

**Work:** Add `connectorName?: string` to `StaticProvider` constructor; thread it from
`makeProvider`. Change `'connector'` literal to `connectorName ?? 'connector'`. Add
`cleanup?(): Promise<void>` to the `files` variant of `ResolvedCredential`; populate from
`applyFileInjection`; call from `connectServer` after `client.connect()` succeeds. Add
explanatory comment in `static.ts`.

---

### C10 — `ResolvedCredential` native variant type-safety

**Goal:** The `oauth` field in `apply: 'native'` is typed as `OAuthClientProvider`, not
`unknown`; the `as` cast in `inject.ts` is eliminated.

**Finding IDs:** Z08-25

**Depends on:** nothing

**Work:** Add `import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'`
to `provider.ts`; change `oauth: unknown` to `oauth: OAuthClientProvider`. Remove the `as`
cast from `inject.ts:181`.

---

### C11 — `makeOAuthProvider` localhost fallback warn + signal-handler cleanup

**Goal:** Deployers who forget `SYM_PUBLIC_URL` see an immediate warning rather than a
silent OAuth failure; `makeSignalHandler` factory is replaced with a plain function.

**Finding IDs:** Z08-29, Z08-28

**Depends on:** nothing

**Work:** Add `SYM_PUBLIC_URL` absence warning in `makeOAuthProvider`. Replace the
`makeSignalHandler` factory with a `handleSignal` function in `materialize.ts`.
