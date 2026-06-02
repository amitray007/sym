# Zone Z06: builtin-tools.ts (the 1679-line monolith)

## Summary

`builtin-tools.ts` is the single most structurally important file in the agent and the most in need of decomposition before open-sourcing. It contains 18 tool descriptors, 8 module-level helper functions, one exported interface (`BuiltinToolDeps`), and one exported factory function (`createBuiltinDispatcher`) whose `dispatch` method is a single 866-line `if/else if` chain. The code is **correct and well-tested** — the underlying logic is solid, comments are accurate, logging is clean (only `console.info`), and there are no North-Star violations. The problem is purely structural: everything is flattened into one file, causing the dispatch method to be untestable in parts (no unit paths for `web_search`, `run_cli`, `set_plan`, `update_task` dispatch), and introducing pervasive copy-paste boilerplate (18 identical `{ callId: call.id, ok: false, error: { code: 'invalid_arguments', message: '...' } }` blocks, 11 identical `const message = err instanceof Error ? err.message : String(err)` patterns, and 17 `else if (call.name ===...)` branches). A tool lookup table (`DESCRIPTORS_BY_NAME`) exists but is used only for actor-routing, not for dispatch — the dispatch method ignores it and uses a name-based chain instead. The path to clean OSS code is a vertical split into one module per tool-family plus a thin registry, leaving `createBuiltinDispatcher` as a thin wiring file.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                                                                                                                                                       | Files                               | Effort  |
| ------ | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------- |
| Z06-01 | high     | complexity  | 866-line `dispatch` method — a single if/else chain for 17 tools                                                                                                                                                                                                            | builtin-tools.ts:811–1679           | medium  |
| Z06-02 | high     | duplication | 18× identical `invalid_arguments` error-result boilerplate                                                                                                                                                                                                                  | builtin-tools.ts (many)             | small   |
| Z06-03 | high     | duplication | 11× identical `const message = err instanceof Error ? err.message : String(err)`                                                                                                                                                                                            | builtin-tools.ts (many)             | small   |
| Z06-04 | high     | structure   | `DESCRIPTORS_BY_NAME` map is built but not used for dispatch (dispatch ignores it)                                                                                                                                                                                          | builtin-tools.ts:779–781,812–830    | small   |
| Z06-05 | medium   | testing     | `web_search`, `run_cli`, `set_plan`, and `update_task` dispatch paths have zero direct unit tests                                                                                                                                                                           | tests/builtin-tools.test.ts         | medium  |
| Z06-06 | medium   | structure   | No module-level doc comment on the file; public surface (`BuiltinToolDeps`, `createBuiltinDispatcher`) lacks context for OSS readers                                                                                                                                        | builtin-tools.ts:1                  | trivial |
| Z06-07 | medium   | complexity  | `search_messages` handler is 166 lines with 5+ levels of nesting and an inline closure (`fieldsFor`) that is called twice per element                                                                                                                                       | builtin-tools.ts:1134–1299          | medium  |
| Z06-08 | medium   | ai-slop     | "Phase B" comment is leftover phased-development language that confuses OSS readers (shipped features don't have phases)                                                                                                                                                    | builtin-tools.ts:367–370            | trivial |
| Z06-09 | medium   | type-safety | 18 branded-type casts (`as SlackChannelId`, `as SlackThreadTs`, `as SlackUserId`, `as PlanItemStatus`, `as string[]`, `as string[][]`) scattered across all handlers after runtime guards                                                                                   | builtin-tools.ts (many)             | small   |
| Z06-10 | medium   | complexity  | `coerceCardFields` and `coerceCardActions` both use `Record<string, unknown>` intermediate cast; they are near-identical and could share an extractor helper                                                                                                                | builtin-tools.ts:725–752            | trivial |
| Z06-11 | low      | complexity  | `resolveAuthorNames` and `formatTranscript` are module-level async helpers but are only called from inside the `read_channel` / `read_thread` handlers; they are not exported and could live next to those handlers                                                         | builtin-tools.ts:207–249            | trivial |
| Z06-12 | low      | naming      | "Phase B" section name plus the static separator comment style (`// -----------`) makes the file look like it has version-layered architecture; replacing with JSDoc comments per tool family would match OSS norms                                                         | builtin-tools.ts:367,546,581        | trivial |
| Z06-13 | low      | type-safety | `ToolRuntimeContext` parameter is always `_ctx` (ignored) in `dispatch`; no handler uses it. Downgrade to `_ctx` with a TODO comment noting it is reserved for future context-bound tools, or remove from the interface's dispatch signature if it is harness-only concern. | builtin-tools.ts:811                | trivial |
| Z06-14 | low      | performance | `fieldsFor(d)` is called twice per search match — once for the prose body and once for the table render — duplicating the DM/channel lookup logic for no benefit                                                                                                            | builtin-tools.ts:1258,1271          | trivial |
| Z06-15 | low      | docs        | `FETCH_URL_DEFAULT_MAX` (8000 chars) and `FETCH_URL_TIMEOUT_MS` (10s) are the two only module-level constants; they have inline comments but lack JSDoc explaining why those values were chosen                                                                             | builtin-tools.ts:23–26              | trivial |
| Z06-16 | low      | consistency | `read_channel`, `read_thread`, `read_user_profile` all clamp/default their limit/ID args inline; `list_channels` and `search_messages` do the same — all five follow the same pattern but no shared helper extracts it                                                      | builtin-tools.ts:844–848, 1087–1089 | small   |
| Z06-17 | low      | testing     | `fieldsFor` closure inside `search_messages` is functionally complex (DM vs channel branch, dedup count, permalink) but is unreachable as a unit — it can only be exercised indirectly through dispatch tests                                                               | builtin-tools.ts:1227–1256          | medium  |

---

## Detail

### Z06-01 — 866-line `dispatch` method

**Evidence:** `createBuiltinDispatcher` returns an object literal whose `dispatch` method spans lines 811–1679 (the entire remainder of the file). It contains a sequential `if / else if / else if ...` chain with exactly 17 tool-name comparisons. The method declares a `let result: ToolResult` mutable variable at the top-level and every branch assigns to it. Cyclomatic complexity is at least 60 (17 branches × ~3 sub-branches each). No sub-function is used to reduce nesting.

**Recommendation:** Introduce a `type ToolHandler = (call: ToolCall, deps: BuiltinToolDeps, resolver: NameResolver) => Promise<ToolResult>` and a `Record<string, ToolHandler>` dispatch table keyed by tool name. Move each tool's handler into its own module under `apps/agent/src/tools/`. `dispatch` becomes a 10-line lookup + invocation. See Proposed Chunks below.

---

### Z06-02 — 18× identical `invalid_arguments` error-result boilerplate

**Evidence:** 26 occurrences of:

```ts
result = {
  callId: call.id,
  ok: false,
  error: { code: 'invalid_arguments', message: '...' },
};
```

18 of which have `message: '... must be a non-empty string'`. The call-site pattern is always `if (typeof arg !== 'string' || arg.length === 0)` followed by this block.

**Recommendation:** Extract two helpers:

```ts
function argError(callId: string, message: string): ToolResult {
  return { callId, ok: false, error: { code: 'invalid_arguments', message } };
}
function execError(callId: string, message: string): ToolResult {
  return { callId, ok: false, error: { code: 'execution_failed', message } };
}
```

Each handler then reads: `return argError(call.id, 'channel_id must be a non-empty string')`.

---

### Z06-03 — 11× identical error-message extraction

**Evidence:**

```ts
// lines 856, 888, 929, 1045, 1127, 1291, 1333, 1378, 1416, 1455 (one more in delete_message)
const message = err instanceof Error ? err.message : String(err);
```

11 identical occurrences inside catch blocks.

**Recommendation:** One shared function `errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }`. Reduces 11 lines to 11 single-identifier references.

---

### Z06-04 — `DESCRIPTORS_BY_NAME` map unused at dispatch time

**Evidence:** At line 779–781 a `Map<string, ToolDescriptor>` is built over all 18 descriptors. At line 815–820 it is used only for `pickClient` (actor routing). The `dispatch` method then ignores this map entirely and uses 17 `if (call.name === '...')` string comparisons. The map could eliminate the chain entirely.

**Recommendation:** Replace the `if/else if` chain with a dispatch table: `const handlers = new Map<string, ToolHandler>(...)`. `dispatch` becomes:

```ts
const handler = handlers.get(call.name);
if (!handler) return { callId: call.id, ok: false, error: { code: 'not_found', ... } };
return handler(call, deps, resolver);
```

---

### Z06-05 — `web_search`, `run_cli`, `set_plan`, `update_task` dispatch untested

**Evidence:** `tests/builtin-tools.test.ts` contains `describe('dispatch() — <tool>')` blocks for 14 tools (lines 299–1533) but has zero dispatch describe-blocks for `web_search`, `run_cli`, `set_plan`, and `update_task`. These four tools only appear in the `list()` test at line 173–196 that asserts names. The `web_search` and `run_cli` handlers each have several validation branches (empty query, non-string argv) and error paths that are never exercised. The `set_plan`/`update_task` handlers have three code paths each (invalid args, no controller, success).

**Recommendation:** Add dispatch test suites for all four tools. For `web_search` / `run_cli` mock the underlying modules. For `set_plan`/`update_task` provide a minimal `PlanController` stub.

---

### Z06-06 — Missing module-level doc comment

**Evidence:** Line 1 is an `import` statement. There is no JSDoc explaining what the file is, what its public surface is, or how tool families are organized. The first `export` is `BuiltinToolDeps` at line 309. An OSS newcomer reading the file has no orientation.

**Recommendation:** Add a brief module-level JSDoc block:

```ts
/**
 * Built-in tool dispatcher for the Sym agent.
 *
 * Defines descriptors and handlers for all in-process tools — Slack reads,
 * owner writes, web fetch, web search, CLI execution, planning, and
 * presentation. Tool routing (bot vs. user Slack token) is governed by the
 * `actor` field on each descriptor.
 *
 * Entry point: {@link createBuiltinDispatcher}.
 */
```

---

### Z06-07 — `search_messages` handler is 166 lines with deep nesting

**Evidence:** Lines 1134–1299 form a single `else if (call.name === 'search_messages')` block. Inside it there is: validation (line 1136), a bot-vs-user guard (line 1142), cache lookup (line 1162), the actual search call (line 1177), dedup (line 1194), parallel name/channel resolution (lines 1205–1218), text rewrite (lines 1219–1221), an inline `fieldsFor` closure (lines 1227–1256), prose body construction (lines 1257–1264), a `render` object (lines 1267–1286), result assignment (line 1287), cache save (line 1289) — all inside nested try/if/else at 14–22 spaces of indentation.

**Recommendation:** Extract the heavy body into a standalone `async function handleSearchMessages(call, deps, resolver, searchCache): Promise<ToolResult>`. Inside it, extract `fieldsFor` to a named module-level function `formatSearchMatch(d, resolver, rewrittenText)`. The outer `dispatch` branch becomes a single `return handleSearchMessages(...)`.

---

### Z06-08 — "Phase B" leftover development comment

**Evidence:**

```
// Line 368:
// Phase B — Act-as-owner write tools (user-token only)
```

This is a software-development phasing artifact from incremental build planning. For an open-source reader, the phrase "Phase B" is meaningless and makes the code look like a staged draft. The feature is shipped; the label should describe the code, not its commit history.

**Recommendation:** Replace with a function-describing JSDoc comment: `/** Write tools that act under the owner's Slack identity (user token required). */`

---

### Z06-09 — 18 branded-type casts after runtime guards

**Evidence:** After a `typeof x !== 'string'` guard, handlers cast with `as SlackChannelId`, `as SlackThreadTs`, etc. — e.g. `channel: channelIdArg as SlackChannelId` at line 850. This is a TypeScript nominal-typing workaround that is correct but verbose and repeated everywhere.

**Recommendation:** If each handler is extracted to its own module, each module can declare typed input extraction once at the top, e.g.:

```ts
const channelId = args['channel_id'] as SlackChannelId; // guarded above
```

Alternatively, a small validated-args helper can centralize the cast and document the pattern.

---

### Z06-10 — Near-identical `coerceCardFields` / `coerceCardActions`

**Evidence:** Lines 725–752 contain two functions that are structurally identical: both iterate an `unknown` array, test for a plain-object element, extract two string properties, and filter malformed entries. The only difference is the property names (`label`/`value` vs. `label`/`url`) and the URL filter in `coerceCardActions`.

**Recommendation:** Extract a shared helper:

```ts
function coercePairs<T>(raw: unknown, validate: (a: string, b: string) => T | null): T[] { ... }
```

`coerceCardFields` and `coerceCardActions` become one-liners.

---

### Z06-11 — `resolveAuthorNames` and `formatTranscript` are channel-read-specific utilities at module scope

**Evidence:** These two async functions (lines 207–249) are only ever called inside the `read_channel` and `read_thread` handlers. They are not exported and have no other callers. Placing them at module scope hides their narrow ownership.

**Recommendation:** When tools are split into separate files, move `resolveAuthorNames` and `formatTranscript` into a `tools/slack-read.ts` or `tools/transcript.ts` module co-located with the handlers that use them.

---

### Z06-12 — C-style separator comments instead of JSDoc groups

**Evidence:** Lines 367, 546, 581 use `// ----------` divider banners to group descriptors. While functional, C-style dividers with caps-lock labels (`// Phase B — Act-as-owner write tools`) are an AI-codegen pattern. OSS conventions use module files or JSDoc `@group` tags.

**Recommendation:** After the file split (Z06-01 chunk), these dividers become irrelevant. If the file is not split immediately, replace the `// ---` dividers with JSDoc `/** ... */` section comments to match the style of the rest of the codebase.

---

### Z06-13 — `_ctx` parameter is always discarded

**Evidence:** Line 811: `async dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult>`. The underscore prefix indicates intentional discard. No handler reads `_ctx`. The `ToolRuntimeContext` carries `channelId`, `requester`, `turnId` which could be useful for context-bound tools but none of the 17 current tools use them.

**Recommendation:** Add a one-line comment: `// _ctx: reserved — harness passes context for future context-bound tools`. This documents the design intent instead of leaving readers wondering why it's always `_`.

---

### Z06-14 — `fieldsFor(d)` called twice per element

**Evidence:** Lines 1258 and 1271: `fieldsFor(d)` is called once for the prose body and once for the table render, for every element in `deduped`. Each call recomputes the DM/channel/who lookup via `resolver` calls. With 20+ results this is 40+ redundant calls.

**Recommendation:** Call `fieldsFor(d)` once per element in a prior `.map()` and destructure the result for both the prose and table sections. Or cache all fields upfront: `const fieldsList = deduped.map(fieldsFor)`.

---

### Z06-15 — Module-level constants lack JSDoc rationale

**Evidence:**

```ts
// Line 23:
const FETCH_URL_DEFAULT_MAX = 8000;
// Line 26:
const FETCH_URL_TIMEOUT_MS = 10_000;
```

The inline comment (`/** Hard ceiling on fetch_url response size (chars after HTML strip). */`) is there for `FETCH_URL_DEFAULT_MAX` but both lack explanation of why the specific value was chosen (context window budget, etc.).

**Recommendation:** Add a note: `// 8000 chars ≈ 6k tokens — keeps fetch_url responses within the model's context budget.`

---

### Z06-16 — Repeated inline clamping/defaulting pattern

**Evidence:** Five tools independently default and clamp numeric limit arguments:

- `read_channel` lines 844–846: `const rawLimit = ... ?? 30; const limit = Math.max(1, Math.min(100, rawLimit));`
- `list_channels` lines 1087–1089: same pattern, limit 1–200
- `search_messages` lines 1156–1158: same pattern, limit 1–100

**Recommendation:** Extract: `function clampedLimit(raw: unknown, def: number, min: number, max: number): number`. Reduces five nearly identical inline blocks.

---

### Z06-17 — `fieldsFor` is tested only indirectly

**Evidence:** The `fieldsFor` closure (lines 1227–1256) handles three distinct cases: regular channel IDs, DM channel IDs, and unknown/missing channel IDs — each with a `Tag` variant for prose and a `Cell` variant for table. The test at `tests/builtin-tools.test.ts:972` ("collapses identical repeats") exercises the DM branch partially, but the channel-only branch, the missing-channel fallback, and the no-`userId` (username-only) path are not exercised as named units.

**Recommendation:** When extracted to a standalone function, add direct unit tests for all three branches of `fieldsFor` (regular channel, DM, fallback).

---

## Tool inventory

| Tool name           | Line (descriptor) | Group       | Actor | Destructive |
| ------------------- | ----------------- | ----------- | ----- | ----------- |
| `get_current_time`  | 28                | utility     | bot   | —           |
| `read_channel`      | 41                | slack-read  | user  | —           |
| `read_thread`       | 69                | slack-read  | user  | —           |
| `read_user_profile` | 94                | slack-read  | user  | —           |
| `list_channels`     | 179               | slack-read  | user  | —           |
| `search_messages`   | 487               | slack-read  | user  | —           |
| `fetch_url`         | 116               | web         | bot   | —           |
| `web_search`        | 140               | web         | bot   | —           |
| `run_cli`           | 158               | exec        | bot   | —           |
| `post_as_owner`     | 376               | slack-write | user  | yes         |
| `react_as_owner`    | 404               | slack-write | user  | yes         |
| `set_status`        | 432               | slack-write | user  | yes         |
| `add_reminder`      | 462               | slack-write | user  | —           |
| `delete_message`    | 557               | slack-write | bot   | yes         |
| `set_plan`          | 590               | plan        | —     | —           |
| `update_task`       | 617               | plan        | —     | —           |
| `present_card`      | 648               | present     | —     | —           |
| `present_table`     | 693               | present     | —     | —           |

Natural groupings → **5 tool families**:

1. **slack-read** — `read_channel`, `read_thread`, `read_user_profile`, `list_channels`, `search_messages` (Slack read API, user-token preferred)
2. **slack-write** — `post_as_owner`, `react_as_owner`, `set_status`, `add_reminder`, `delete_message` (write/mutate Slack state)
3. **web** — `fetch_url`, `web_search` (external HTTP)
4. **exec** — `run_cli` (subprocess execution)
5. **ui** — `get_current_time`, `set_plan`, `update_task`, `present_card`, `present_table` (pure in-process / plan / rendering)

---

## Proposed chunks

### Chunk 1: Extract shared boilerplate helpers (no behavior change)

**Goal:** Eliminate the three repeated boilerplate patterns (invalid-args result builder, exec-error result builder, `errMsg` error extractor) by introducing three small module-level helpers used throughout the file. All existing tests pass without modification. Zero behavior change.

**Depends on:** nothing

**Finding IDs:** Z06-02, Z06-03

---

### Chunk 2: Extract `fieldsFor` and fix double-call

**Goal:** Move the `fieldsFor` closure out of `search_messages` into a module-level named function. Call it once per match element (caching result). Add direct unit tests for its three branches.

**Depends on:** nothing (standalone refactor)

**Finding IDs:** Z06-07 (partial), Z06-14, Z06-17

---

### Chunk 3: Add missing dispatch test suites

**Goal:** Add `describe('dispatch() — web_search')`, `describe('dispatch() — run_cli')`, `describe('dispatch() — set_plan')`, `describe('dispatch() — update_task')` in `tests/builtin-tools.test.ts`. Cover happy path, invalid-args branch, and error/exception path for each.

**Depends on:** nothing

**Finding IDs:** Z06-05

---

### Chunk 4: Replace if/else chain with a dispatch table

**Goal:** `dispatch` becomes a 10-line lookup over a `Map<string, ToolHandler>`. Each tool's handler is a named `async function handle_<name>` at module scope (still in `builtin-tools.ts`). The `DESCRIPTORS_BY_NAME` map is reused. No behavior change; existing tests pass.

**Depends on:** Chunk 1 (helpers in place first)

**Finding IDs:** Z06-01, Z06-04

---

### Chunk 5: Split into `tools/` directory

**Goal:** Create `apps/agent/src/tools/<family>.ts` for each of the 5 groups. Each file exports its descriptor array and its handler(s). `builtin-tools.ts` becomes a thin wiring file that imports all handlers, builds the dispatch table, and exports `createBuiltinDispatcher`. Module-level doc comments added (Z06-06). "Phase B" comment replaced (Z06-08). `_ctx` comment added (Z06-13). Separator comments removed (Z06-12).

**Depends on:** Chunk 4 (dispatch table must exist before split)

**Finding IDs:** Z06-01 (final), Z06-06, Z06-08, Z06-11, Z06-12, Z06-13

---

### Chunk 6: Polish — near-identical coerce helpers, clamping helper, constant docs

**Goal:** `coerceCardFields`/`coerceCardActions` share a generic `coercePairs` helper. `clampedLimit` extracted. `FETCH_URL_DEFAULT_MAX` and `FETCH_URL_TIMEOUT_MS` get rationale comments. Branded-type casts consolidated per module.

**Depends on:** Chunk 5

**Finding IDs:** Z06-09, Z06-10, Z06-15, Z06-16
