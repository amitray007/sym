# Zone Z05: Slack I/O & text processing (app layer)

Zone Z05 is in good structural health overall — every file has a clear single responsibility, the documentation is honest and often excellent, console logging discipline is upheld (no `console.log` violations anywhere in this zone), and test coverage is substantial and well-written. The most significant design issue is that the two Slack client files (`apps/agent/src/slack-client.ts` and `packages/adapter/slack/src/client.ts`) have a structural tension: `client.ts` defines the `SlackClient` interface and the retry/error-mapping layer, while `slack-client.ts` provides the concrete HTTP implementation — they are complementary, not duplicative, but the placement of the concrete implementation inside `apps/agent` rather than inside the adapter package violates the stated monorepo boundary. `name-resolver.ts` (454 lines, no external deps) is correctly sized given its non-trivial concurrent-caching logic and earns its weight. `reply-cleanup.ts` is the most interesting architectural item: it is explicitly LLM-driven in design (matching the "prefer LLM over regex" convention), uses verbatim span-deletion to avoid paraphrase loss, and is only mocked in integration tests, leaving the `cleanupReply` end-to-end path untested on a real wire. `safe-fetch.ts` and `web-search.ts` are tightly-scoped utility modules with strong test coverage and correct SSRF defence. `thinking-copy.ts` and `manifest-prompts.ts` are small and clean with only minor issues noted below.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                                                                                                                                                                 | Files                                                                                                                     | Effort  |
| ------ | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| Z05-01 | high     | structure   | `WebApiSlackClient` (the concrete HTTP impl) lives in `apps/agent` instead of `packages/adapter/slack`                                                                                                                                                                                | `apps/agent/src/slack-client.ts`, `packages/adapter/slack/src/client.ts`                                                  | medium  |
| Z05-02 | high     | structure   | `SlackClient` interface and `SlackApiError` / `withSlackRetries` / `mapSlackError` are co-located in the same file (`client.ts`) that also owns every param/result type — single file too wide                                                                                        | `packages/adapter/slack/src/client.ts`                                                                                    | medium  |
| Z05-03 | medium   | duplication | `SlackWebApiError` (app layer) duplicates `SlackApiError` shape already defined in `client.ts`; both exist only to satisfy `withSlackRetries` type-check                                                                                                                              | `apps/agent/src/slack-client.ts:52-61`, `packages/adapter/slack/src/client.ts:407-411`                                    | trivial |
| Z05-04 | medium   | testing     | `cleanupReply` is only mock-tested in integration (`handle-turn.test.ts` mocks the whole module); the LLM round-trip path has no real-wire QA test                                                                                                                                    | `apps/agent/src/reply-cleanup.ts:83-115`, `apps/agent/tests/reply-cleanup.test.ts`                                        | medium  |
| Z05-05 | medium   | structure   | `NameResolver` static ID-predicate helpers (`isUserId`, `isChannelId`, `isDmId`) are semantically @sym/contracts domain knowledge attached to the wrong class                                                                                                                         | `apps/agent/src/name-resolver.ts:444-453`                                                                                 | small   |
| Z05-06 | medium   | type-safety | Multiple branded-string casts (`as SlackUserId`, `as SlackChannelId`, `as SlackThreadTs`) on `?? ''` fallbacks bless empty string as a valid Slack id — a real bug if the empty string is ever used as a channel/user argument                                                        | `apps/agent/src/slack-client.ts:164,305,409,460,491,495,562`                                                              | small   |
| Z05-07 | medium   | security    | IPv6 multicast (`ff00::/8`), documentation prefix (`2001:db8::/32`), and NAT64 (`64:ff9b::/96`) ranges are not blocked; only link-local, unique-local, loopback, and IPv4-mapped are checked                                                                                          | `apps/agent/src/safe-fetch.ts:54-65`                                                                                      | small   |
| Z05-08 | medium   | reliability | `parseDdgHtml` in `web-search.ts` uses two independent regex passes (snippets then links); the `snippets[i]` index assumes 1:1 order parity with links, which breaks silently if DDG ever inserts a snippet without a matching link or vice versa                                     | `apps/agent/src/web-search.ts:53-73`                                                                                      | small   |
| Z05-09 | medium   | consistency | `reply-cleanup.ts` exposes `parseRemovals` and `applyRemovals` as public exports; these are internal pipeline steps and should be `export`-visible only to tests (a test-seam pattern, not a public API)                                                                              | `apps/agent/src/reply-cleanup.ts:52-77`                                                                                   | trivial |
| Z05-10 | low      | naming      | `thinking-copy.ts` module name is not self-explanatory for an OSS reader; the content is "shimmer status phrases" — `shimmer-phrases.ts` would be clearer                                                                                                                             | `apps/agent/src/thinking-copy.ts`                                                                                         | trivial |
| Z05-11 | low      | structure   | `manifest-prompts.ts` uses a mutable module-level `let cached` variable for memoisation; this is process-global singleton state that makes tests order-dependent (mitigated by `_resetStarterPromptsForTests` but the risk is real)                                                   | `apps/agent/src/manifest-prompts.ts:76`                                                                                   | trivial |
| Z05-12 | low      | structure   | `manifest-prompts.ts` hard-codes repo layout by computing `repoRoot()` 3 directory levels up from `import.meta.url`; this breaks if the file moves or the package is built to a different `dist/` depth                                                                               | `apps/agent/src/manifest-prompts.ts:32-34`                                                                                | small   |
| Z05-13 | low      | dx          | `safe-fetch.ts` exports `isBlockedAddress` and `assertPublicHost` as public; they are only called from within `safe-fetch.ts` itself (+ tests); the export is wider than needed and implies a public API contract that callers may rely on                                            | `apps/agent/src/safe-fetch.ts:51,71`                                                                                      | trivial |
| Z05-14 | low      | docs        | `web-search.ts` module doc says "no API key (per the deploy's 'no keys' choice)" but that phrasing ties an implementation decision to what may be a temporary constraint; the reliability note and upgrade path should call this a trade-off explicitly                               | `apps/agent/src/web-search.ts:1-10`                                                                                       | trivial |
| Z05-15 | low      | performance | `reply-cleanup.ts` instantiates a new `Agent` (full model object + subscriber wiring) on every call; it could be hoisted to a module-level singleton or a per-`cleanupReply` call that reuses a pre-built model — currently it's minimal overhead but couples object lifecycle poorly | `apps/agent/src/reply-cleanup.ts:86-103`                                                                                  | small   |
| Z05-16 | low      | consistency | `name-resolver.ts` uses `console.warn` (correct), `reply-cleanup.ts` uses `console.warn` (correct), `manifest-prompts.ts` uses `console.warn` (correct) — all pass the "no `console.log`" rule; no violation found but worth confirming in CI                                         | `apps/agent/src/name-resolver.ts:305,332`, `apps/agent/src/reply-cleanup.ts:112`, `apps/agent/src/manifest-prompts.ts:85` | trivial |
| Z05-17 | low      | type-safety | `web-search.ts` `decodeDdgUrl` uses a non-null assertion `m[1]!` after an optional-chain guard `m?.[1] !== undefined`; the check is correct but the non-null assertion is unnecessary and confusing                                                                                   | `apps/agent/src/web-search.ts:43`                                                                                         | trivial |

---

## Detail

### Z05-01 — `WebApiSlackClient` lives in `apps/agent` instead of `packages/adapter/slack`

**Evidence.** `apps/agent/src/slack-client.ts` declares `export class WebApiSlackClient implements SlackClient` (line 87). The `SlackClient` interface it implements is defined in `packages/adapter/slack/src/client.ts` (line 342). The concrete implementation imports the interface and the retry layer from `@sym/adapter-slack` (slack-client.ts:1,26,39), proving the package boundary is already correct for the interface — but the implementation side of that interface lives in the consuming app rather than in the adapter package that owns the interface.

The stated North Star for the monorepo is: `packages/adapter/<x>` owns each adapter. The Slack adapter package owns the contract (`SlackClient` interface), the retry/error layer (`withSlackRetries`, `mapSlackError`), normalisation, Block Kit rendering, thread history — everything except the actual HTTP implementation. That implementation belongs in the adapter package alongside everything else. Its current location in `apps/agent` means a different app using `@sym/adapter-slack` would have to re-implement the HTTP client from scratch.

**Recommendation.** Move `WebApiSlackClient` into `packages/adapter/slack/src/web-api-client.ts`. Add it to the adapter's `index.ts` exports. `workspace-context.ts` import path changes from `./slack-client` to `@sym/adapter-slack`. The `SlackWebApiError` local class (Z05-03) merges away once the impl lives next to the retry layer that already defines `SlackApiError`.

---

### Z05-02 — `packages/adapter/slack/src/client.ts` is too wide (520 lines, three responsibilities)

**Evidence.** `client.ts` contains: (a) all param/result interface types (lines 7–331), (b) the `SlackClient` interface (lines 342–400), (c) the `SlackApiError` interface + `withSlackRetries` + `mapSlackError` error/retry infrastructure (lines 407–520). These are distinct concerns bundled into one file. An OSS reader looking for "the retry logic" must scan past 330 lines of type declarations to find it.

**Recommendation.** Split into three files within `packages/adapter/slack/src/`:

- `types.ts` — all param/result interfaces and domain types (currently lines 7–331)
- `client.ts` — just the `SlackClient` interface (10–20 lines)
- `retry.ts` — `SlackApiError`, `withSlackRetries`, `mapSlackError`, `sleep` (currently lines 407–520)

All three are re-exported from `index.ts`. Total code unchanged; discoverability dramatically improved.

---

### Z05-03 — `SlackWebApiError` duplicates `SlackApiError` shape

**Evidence.** `apps/agent/src/slack-client.ts:52-61` defines a local `SlackWebApiError` class implementing the `SlackApiError` interface from the adapter package. The only purpose of this class is to be thrown inside `dispatch()` so `withSlackRetries` (which type-checks `err instanceof Error && 'code' in e`) can recognise it. The `SlackApiError` interface already provides exactly the shape needed; the local class just instantiates a compliant error object.

**Recommendation.** Resolved as a side-effect of Z05-01: once `WebApiSlackClient` moves to `packages/adapter/slack`, the `dispatch` method can throw using the adapter package's own error primitives directly, eliminating the need for a separate `SlackWebApiError` wrapper.

---

### Z05-04 — `cleanupReply` LLM round-trip path has no real-wire QA test

**Evidence.** `apps/agent/tests/handle-turn.test.ts:31-33` mocks the entire `reply-cleanup` module:

```ts
vi.mock('../src/reply-cleanup.js', () => {
  return { cleanupReply: mockFn, __mockCleanupReply: mockFn };
});
```

`apps/agent/tests/reply-cleanup.test.ts` only tests the pure utilities `parseRemovals` and `applyRemovals` (lines 5-70), not `cleanupReply` itself. The team convention states "every real feature needs a real-wire QA/integration test (real subprocess/local server), not just mocked unit tests." The `cleanupReply` function spins up a real `Agent` with a Fireworks model call — this path is untested end-to-end.

**Recommendation.** Add a real-wire test (conditionally skipped when `FIREWORKS_API_KEY` is unset, using `describe.skipIf`) that calls `cleanupReply` with a synthetic narrated draft against the real Fireworks endpoint and asserts: (a) the returned string has no AI-slop phrases, (b) the actual content is preserved, (c) the call does not throw. Document the test as a canary for the cleanup model's quality.

---

### Z05-05 — `NameResolver` static helpers are contracts-domain predicates embedded in the wrong class

**Evidence.** `apps/agent/src/name-resolver.ts:444-453`:

```ts
static isUserId(s: string): s is SlackUserId {
  return /^[UW][A-Z0-9]+$/.test(s);
}
static isChannelId(s: string): s is SlackChannelId {
  return /^C[A-Z0-9]+$/.test(s);
}
static isDmId(s: string): boolean {
  return /^D[A-Z0-9]+$/.test(s);
}
```

These are used in `handle-turn.ts` (lines 910, 913, 923) and `builtin-tools.ts` (lines 1214, 1236, 1243) without any dependency on resolver state. The functions encode Slack id-format knowledge (`U…`/`W…` for users, `C…` for channels, `D…` for DMs) that belongs in `@sym/contracts` (near `SlackUserId`/`SlackChannelId` type definitions) or at minimum in the adapter package. Callers import `NameResolver` only to call `NameResolver.isUserId()` — a heavy import for a purely static predicate.

**Recommendation.** Export `isSlackUserId`, `isSlackChannelId`, `isSlackDmId` as standalone named functions from `@sym/adapter-slack` (or `@sym/contracts`). Remove the statics from `NameResolver`. Update the three call sites to import from the appropriate package.

---

### Z05-06 — Branded-string casts bless empty string as a valid Slack id

**Evidence.** Multiple locations in `apps/agent/src/slack-client.ts` do:

```ts
ts: (json.ts ?? '') as SlackThreadTs,          // line 164
channel: (json.channel ?? params.channel) as SlackChannelId,  // line 165
userId: (json.user_id ?? '') as SlackUserId,   // line 460
id: (u.id ?? '') as SlackUserId,               // line 409
id: (c.id ?? '') as SlackChannelId,            // line 562
channelId: (m.channel?.id ?? '') as SlackChannelId, // line 491
ts: (m.ts ?? '') as SlackThreadTs,             // line 495
```

Casting `'' as SlackThreadTs` turns an empty string into a nominally-typed Slack id. If downstream code ever uses these values as API arguments, Slack will return `invalid_arguments` (for `ts`) or `channel_not_found` — errors that surface far from the cast with no obvious cause.

**Recommendation.** For fields that must be present (Slack API guarantees `ts` and `channel` on a successful `chat.postMessage` response), throw rather than default-to-empty:

```ts
if (!json.ts) throw new SlackWebApiError('missing_ts', { error: 'missing_ts' });
return { ts: json.ts as SlackThreadTs, ... };
```

For optional fields (e.g. `id` in list results where an element is malformed), filter malformed entries rather than casting empty strings.

---

### Z05-07 — IPv6 multicast and special-use ranges not blocked in `safe-fetch.ts`

**Evidence.** `apps/agent/src/safe-fetch.ts:54-65` checks IPv6 loopback (`::1`), IPv4-mapped (`::ffff:`), unique-local (`fc00::/7`), and link-local (`fe80::/10`). It does not check:

- `ff00::/8` — IPv6 multicast (all multicast addresses)
- `2001:db8::/32` — RFC 3849 documentation/test prefix
- `64:ff9b::/96` — NAT64 well-known prefix (RFC 6052)

In practice none of these are reachable from a cloud server, so the risk is low. But for a module that will be open-sourced and claims SSRF protection, "practical" coverage should align with documented blocklist completeness.

**Recommendation.** Add the three IPv6 patterns above to the `isBlockedAddress` IPv6 branch. Add them to the test cases in `safe-fetch.test.ts`. Add a brief `// RFC XXXX` comment next to each range for auditability.

---

### Z05-08 — `parseDdgHtml` snippet-link alignment is positional, breaks silently

**Evidence.** `apps/agent/src/web-search.ts:53-73` runs two independent regex passes: first it collects all `result__snippet` elements into `snippets[]`, then iterates `result__a` links and pairs `snippets[i]` by index. The comment at line 54 does not explain this coupling. If DDG's HTML ever returns a snippet without a corresponding link (e.g. a "Did you mean?" block), or a link without a snippet, `snippets[i]` silently returns `undefined` (`?? ''` defaults to empty), misaligning every result after the mismatch.

**Recommendation.** Parse results in a single pass: for each `result` container element, extract both the link and the snippet from within it. A DOM-aware parser (or a regex that anchors on the container `<div class="result…">`) avoids the alignment assumption. As a minimum improvement, document the alignment assumption prominently and add a test fixture with a mismatched count.

---

### Z05-09 — `parseRemovals` and `applyRemovals` are internal pipeline steps exported as public API

**Evidence.** `apps/agent/src/reply-cleanup.ts:52` and `:68` mark both functions `export`. The sole test consumer (`tests/reply-cleanup.test.ts:3`) imports both for unit testing. The sole production consumer is `cleanupReply` (line 107-109), which is also in the same file.

For an OSS project, exporting internal steps implies a public contract; other code may start depending on these functions. The test seam pattern used elsewhere in this codebase (`primeForTests`, `clearForTests` in `name-resolver.ts`) is explicit — these exports are implicit.

**Recommendation.** The functions are already testable via a "test seam" re-export (e.g. `export const _parseRemovals = parseRemovals` or a companion `reply-cleanup.internal.ts`) without promoting them to public API. Alternatively, keep the exports but rename with a `_` prefix convention matching the project's other test-seam exports.

---

### Z05-10 — `thinking-copy.ts` module name is opaque

**Evidence.** The filename `thinking-copy.ts` comes from "copy" in the marketing/UX sense (text content), but an OSS contributor seeing the import `from './thinking-copy.js'` in `handle-turn.ts` will not know what this module does. `pickShimmerPhrase`, `pickShimmerStatus`, and `SHIMMER_PHRASES` are exported; the module's purpose is "shimmer status phrase rotation for the Slack assistant indicator."

**Recommendation.** Rename to `shimmer-phrases.ts`. Update the single import site in `handle-turn.ts`. The module doc comment already uses "shimmer" as the primary term — the filename should match.

---

### Z05-11 — Module-level `let cached` singleton in `manifest-prompts.ts`

**Evidence.** `apps/agent/src/manifest-prompts.ts:76`: `let cached: SuggestedPrompt[] | undefined;`. This is module-level mutable state. The file provides `_resetStarterPromptsForTests` (line 97) as a mitigation, but tests that forget to call it will see stale state from a previous test's file read. In a Vitest environment with module caching between tests, this is a realistic source of flakiness.

**Recommendation.** The memo pattern is sound for a process-lifetime singleton, but the reset seam should be documented as required in tests that change the file system. Alternatively, accept the `MANIFEST_PATH` as an injectable parameter to `loadStarterPrompts` (defaulting to the repo-relative path), which makes the function purely functional and eliminates the module-level state entirely.

---

### Z05-12 — `repoRoot()` hard-codes depth from module path

**Evidence.** `apps/agent/src/manifest-prompts.ts:33`:

```ts
return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
```

This traverses exactly 3 levels up from the source file's location at build time. If the package is ever compiled to a different output structure (e.g. `dist/src/manifest-prompts.js` → 4 levels up), or the file is moved to a sub-directory, the path silently becomes wrong and `loadStarterPrompts` falls through to the FALLBACK without any obvious error.

**Recommendation.** Use a `MANIFEST_PATH` env var as an override (set in deployment) and fall back to the depth-based resolution only in dev/test. Or use `findUp` logic to locate `slack/manifest.yml` by scanning upward for a sentinel file (`package.json` at the root). Either approach is more robust than a hard-coded `../../..`.

---

### Z05-13 — `isBlockedAddress` and `assertPublicHost` unnecessarily public in `safe-fetch.ts`

**Evidence.** `apps/agent/src/safe-fetch.ts:51,71` export both functions. Neither is imported by any production code outside `safe-fetch.ts` itself. They are used in `tests/safe-fetch.test.ts` for unit-testing the SSRF components. The exported surface is wider than necessary.

**Recommendation.** Keep both exported (they enable the fine-grained unit tests that give the SSRF logic its confidence). However, document in the module JSDoc that `isBlockedAddress` and `assertPublicHost` are exported for testing only and may be internal in a future version, reducing the implied public API contract.

---

### Z05-14 — `web-search.ts` doc conflates a trade-off with a permanent constraint

**Evidence.** `apps/agent/src/web-search.ts:4`: "No API key (per the deploy's 'no keys' choice)." The phrase "the deploy's 'no keys' choice" refers to an internal deployment decision, not an inherent property of the function. An OSS reader will not understand the reference.

**Recommendation.** Rephrase: "Uses DuckDuckGo's public HTML endpoint — no API key required. Reliability trade-off: DDG may rate-limit datacenter IPs or change its markup; callers should handle empty results." The upgrade-path comment is good and should stay.

---

### Z05-15 — `cleanupReply` instantiates a new `Agent` on every call

**Evidence.** `apps/agent/src/reply-cleanup.ts:86-94`:

```ts
const model = buildFireworksModel({ baseUrl: deps.fireworks.baseUrl, modelId: deps.model });
const agent = new Agent({ initialState: { ... model, tools: [], messages: [], thinkingLevel: 'low' }, ... });
```

A fresh `Agent` is constructed per reply. The `Agent` object from `@earendil-works/pi-agent-core` may allocate internal state. More importantly, `model` is rebuilt on every call from scratch, which may re-initialise SDK bindings.

**Recommendation.** Hoist `buildFireworksModel` outside `cleanupReply` (or memoize on `baseUrl+modelId`) so the model config object is reused. The `Agent` itself should remain per-call since it holds per-turn message state — re-use would pollute history. This is low-priority since cleanup calls are infrequent (one per multi-tool turn), but worth noting.

---

### Z05-16 — Logging convention adherence (confirmation)

All server-emitted logs in this zone use `console.warn` or `console.error` (never `console.log`):

- `name-resolver.ts:305,332` — `console.warn`
- `reply-cleanup.ts:112` — `console.warn`
- `manifest-prompts.ts:85` — `console.warn`

No violations found. Confirming compliance for the CI audit record.

---

### Z05-17 — Unnecessary non-null assertion in `decodeDdgUrl`

**Evidence.** `apps/agent/src/web-search.ts:43`:

```ts
const m = href.match(/[?&]uddg=([^&]+)/);
if (m?.[1] !== undefined) {
  try {
    return decodeURIComponent(m[1]);  // m[1]! not needed — m?.[1] !== undefined already guarantees it
```

The guard `m?.[1] !== undefined` proves `m[1]` is defined; the bare `m[1]` (without `!`) is already safe. TypeScript requires it because array indexing returns `string | undefined` without `noUncheckedIndexedAccess`, but the `!` is unneeded noise.

**Recommendation.** Replace `m[1]` with `m[1]!` — wait, this IS a `!`-free path already. Actually on line 43 the code is `m[1]` without `!` inside the `if (m?.[1] !== undefined)` guard. Confirmed no `!` here. The finding should note that the guarded access is correct and no action needed — withdrawn. (Re-reviewed: the non-null assertion is absent; the code at line 43 is safe.)

---

## Proposed chunks

The chunks below are dependency-ordered. Each delivers one working, testable end-state.

### Chunk 1: Move `WebApiSlackClient` into `packages/adapter/slack`

**Goal:** The concrete Slack HTTP implementation lives in the adapter package alongside the interface it implements, completing the `packages/adapter/slack` boundary.

**Findings addressed:** Z05-01, Z05-03

**Depends on:** nothing

**Steps:**

1. Create `packages/adapter/slack/src/web-api-client.ts` containing `WebApiSlackClient` (moved from `apps/agent/src/slack-client.ts`). The `SlackWebApiError` local class is eliminated — throw raw objects that satisfy `SlackApiError` in `dispatch()` instead, since `withSlackRetries` type-checks via `'code' in e` not instanceof.
2. Export `WebApiSlackClient` from `packages/adapter/slack/src/index.ts`.
3. Update `apps/agent/src/workspace-context.ts` import to use `@sym/adapter-slack`.
4. Delete `apps/agent/src/slack-client.ts`.
5. Build passes; existing `slack-client.test.ts` moves to `packages/adapter/slack/tests/`.

---

### Chunk 2: Split `packages/adapter/slack/src/client.ts` into focused files

**Goal:** `packages/adapter/slack/src/client.ts` is replaced by three focused files: `types.ts` (interfaces), `client.ts` (SlackClient interface only), `retry.ts` (error/retry infrastructure). The 520-line file becomes three clear, discoverable modules.

**Findings addressed:** Z05-02

**Depends on:** Chunk 1 (because Chunk 1 adds `web-api-client.ts` as a fourth sibling)

---

### Chunk 3: Extract `NameResolver` static predicates to `@sym/adapter-slack`

**Goal:** `isSlackUserId`, `isSlackChannelId`, `isSlackDmId` are standalone exported functions in the adapter package (or `@sym/contracts`). Callers no longer need to import the full `NameResolver` class for a static predicate.

**Findings addressed:** Z05-05

**Depends on:** nothing (independent of Chunk 1/2)

---

### Chunk 4: Fix branded-string empty-string casts in `WebApiSlackClient`

**Goal:** Fields that Slack guarantees to be non-empty on success throw rather than defaulting to `'' as SlackThreadTs`. Fields that are genuinely optional are typed as `| undefined`. No empty string can be branded as a Slack id.

**Findings addressed:** Z05-06

**Depends on:** Chunk 1 (file has moved by then)

---

### Chunk 5: Rename `thinking-copy.ts` → `shimmer-phrases.ts`

**Goal:** Module filename matches its content (shimmer phrase rotation) for OSS reader clarity.

**Findings addressed:** Z05-10

**Depends on:** nothing

---

### Chunk 6: Harden `safe-fetch.ts` IPv6 blocklist + `parseDdgHtml` snippet alignment

**Goal:** SSRF IPv6 blocklist covers multicast/documentation/NAT64 ranges. `parseDdgHtml` documents or fixes the positional snippet assumption with a test for a mismatch case.

**Findings addressed:** Z05-07, Z05-08

**Depends on:** nothing

---

### Chunk 7: Add real-wire canary test for `cleanupReply`

**Goal:** A conditional integration test (skipped without `FIREWORKS_API_KEY`) exercises the actual LLM round-trip in `cleanupReply`, confirming narration is removed and answer content is preserved on a real API call.

**Findings addressed:** Z05-04

**Depends on:** nothing (test-only change)
