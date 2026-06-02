# Zone Z12: packages/adapter/slack

## Summary

The `@sym/adapter-slack` package is the cleanest and most coherent boundary in the codebase. Its structure follows the North Star pattern well: a typed `SlackClient` interface (owned here) whose concrete implementation lives in `apps/agent/src/slack-client.ts`, rich Block Kit builders, intent-based rendering, signature verification, thread hydration, and a receipt formatter. Test coverage is thorough — every module except `client.ts` (which cannot be unit-tested without live network or deep mocking) has a matching test file. The principal problems are: (1) a stale `dist/dedup.{js,d.ts}` artifact from a deleted `src/dedup.ts` that is no longer part of the package but ships in the built output; (2) three interface fields typed as `blocks?: unknown[]` instead of `SlackBlock[]`; (3) two near-identical functions (`assistantThreadStarted` / `assistantThreadContextChanged`) that share all their logic and differ only in the event-type string they test; (4) a duplicated leading-mention strip helper between `normalize.ts` and `thread.ts`; (5) `splitForBlocks` exported but never directly tested; (6) `usersList` payload shape is missing `status_text`/`status_emoji` fields that `usersInfo` maps correctly; and (7) `mapSlackError` is exported from `client.ts` but is also re-exported through `index.ts` via `export * from './client.js'`, surfacing an internal detail that callers should not depend on. There is NO duplication of the `SlackClient` implementation — the adapter owns only the interface and the concrete `WebApiSlackClient` lives solely in the app layer. Overall the package is in good health; the issues are low-to-medium severity.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                                                                                                                                                      | Files                                                                                                 | Effort  |
| ------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| Z12-01 | high     | dead-code   | Stale `dist/dedup.*` artifact from deleted `src/dedup.ts` ships in built package                                                                                                                                                                                           | `packages/adapter/slack/dist/dedup.js`, `dist/dedup.d.ts`, `dist/dedup.d.ts.map`, `dist/dedup.js.map` | trivial |
| Z12-02 | medium   | type-safety | `blocks` params typed as `unknown[]` instead of `SlackBlock[]`                                                                                                                                                                                                             | `packages/adapter/slack/src/client.ts:11,30,258`                                                      | small   |
| Z12-03 | medium   | duplication | `assistantThreadStarted` and `assistantThreadContextChanged` are identical code paths differing only in event-type string                                                                                                                                                  | `packages/adapter/slack/src/normalize.ts:300-330`                                                     | trivial |
| Z12-04 | medium   | duplication | `stripLeadingMention` duplicated between `normalize.ts` and `thread.ts`                                                                                                                                                                                                    | `packages/adapter/slack/src/normalize.ts:83-85`, `packages/adapter/slack/src/thread.ts:44-46`         | trivial |
| Z12-05 | medium   | type-safety | `mapSlackError` exported from the package (via `export * from './client.js'`) — internal detail not meant for external callers                                                                                                                                             | `packages/adapter/slack/src/client.ts:488`, `packages/adapter/slack/src/index.ts:5`                   | trivial |
| Z12-06 | low      | testing     | `splitForBlocks` exported and used but never directly unit-tested; only exercised indirectly via `markdownBlocks`                                                                                                                                                          | `packages/adapter/slack/src/blocks.ts:130-144`, `packages/adapter/slack/tests/blocks.test.ts`         | trivial |
| Z12-07 | low      | consistency | `usersList` payload shape omits `status_text`/`status_emoji` fields that `usersInfo` correctly maps; boot-time name-cache loses status info                                                                                                                                | `apps/agent/src/slack-client.ts:386-387` (not this zone, flagged for Z05 coordination)                | small   |
| Z12-08 | low      | docs        | `assistantThreadContextChanged` JSDoc says "Reuses the `AssistantThreadStarted` interface" but does not explain WHY two events share the same shape; the duplication is more confusing than helpful                                                                        | `packages/adapter/slack/src/normalize.ts:313-317`                                                     | trivial |
| Z12-09 | low      | type-safety | `ActionsBlock.elements` typed as `unknown[]` — no structural contract on action elements                                                                                                                                                                                   | `packages/adapter/slack/src/blocks.ts:52-54`                                                          | small   |
| Z12-10 | low      | consistency | `withRetries` loop uses `while (attempt <= maxRetries)` which iterates `maxRetries + 1` times total; the comment says "max retries" but the unreachable `throw` after the loop is never hit because the last retry is `attempt === maxRetries` then throws inside the loop | `packages/adapter/slack/src/client.ts:450-484`                                                        | trivial |
| Z12-11 | low      | naming      | `VerifyResult` type in `verify.ts` is unexported but usable by callers — hiding the result type forces callers to infer it instead of importing it explicitly                                                                                                              | `packages/adapter/slack/src/verify.ts:9`                                                              | trivial |
| Z12-12 | low      | dead-code   | `splitForBlocks` is exported from `blocks.ts` but never imported anywhere outside the file (only called internally by `markdownBlocks`); the export is unnecessary public surface                                                                                          | `packages/adapter/slack/src/blocks.ts:130`                                                            | trivial |
| Z12-13 | low      | docs        | Module-level doc comment is absent from `thread.ts`, `receipt.ts`, `verify.ts`, and `blocks.ts` — `render.ts` has a good one; the others have inline comments but no module description                                                                                    | `packages/adapter/slack/src/thread.ts:1`, `receipt.ts:1`, `verify.ts:1`, `blocks.ts:1`                | trivial |
| Z12-14 | low      | consistency | `conversationsHistory` uses the `RepliesResponse` interface (named for `conversations.replies`) for the history endpoint call — confusing reuse                                                                                                                            | `apps/agent/src/slack-client.ts:247` (not this zone — flagged for Z05)                                | trivial |

---

## Detail

### Z12-01 — Stale `dist/dedup.*` artifact (high / dead-code)

`src/dedup.ts` was deleted from the package (the file does not exist in `src/`), but its compiled output was never cleaned:

```
packages/adapter/slack/dist/dedup.js
packages/adapter/slack/dist/dedup.d.ts
packages/adapter/slack/dist/dedup.d.ts.map
packages/adapter/slack/dist/dedup.js.map
```

The declaration file (`dist/dedup.d.ts`) exports a `DedupStore` interface and an `extractDedupKey` function that are no longer part of the package surface — but they ARE present in the built output and would be shipped to anyone who installs the package. `index.ts` does not re-export them, so they are not accessible as named imports, but the stale artifacts are confusing and pollute the dist directory. OSS contributors looking at the compiled output would encounter dead interface definitions with no corresponding source.

**Recommendation:** Run `tsc --build --clean` for the package (or manually delete the four stale dist files), then rebuild. Add a `pretest` / `prebuild` clean step in the package `scripts` to prevent recurrence.

---

### Z12-02 — `blocks` params typed as `unknown[]` (medium / type-safety)

Three interfaces in `client.ts` carry `blocks?: unknown[]`:

- `PostMessageParams:11` — `blocks?: unknown[]`
- `UpdateMessageParams:30` — `blocks?: unknown[]`
- `StopStreamParams:258` — `blocks?: unknown[]`

`SlackBlock` is defined and exported by `blocks.ts` in this same package. Using `unknown[]` breaks type-checking on callers: the compiler accepts any array and cannot catch structural mismatches (e.g. passing a `RenderIntent` directly).

**Recommendation:** Replace `blocks?: unknown[]` with `blocks?: SlackBlock[]` in all three interfaces. Import `SlackBlock` from `'./blocks.js'`. This is a tightening change with no runtime effect; existing callers already pass `SlackBlock[]` arrays.

---

### Z12-03 — Duplicated `assistantThread*` functions (medium / duplication)

`normalize.ts:300-330` contains two near-identical functions:

```ts
// assistantThreadStarted (line 300)
if (raw.type !== 'event_callback' || raw.event?.type !== 'assistant_thread_started') return null;
...
// assistantThreadContextChanged (line 318)
if (raw.type !== 'event_callback' || raw.event?.type !== 'assistant_thread_context_changed') return null;
```

The bodies are character-for-character identical; only the event type string differs. This is a textbook extraction opportunity.

**Recommendation:** Extract a private helper `extractAssistantThread(raw, eventType)` that contains the shared body. The two public functions become one-liners delegating to the helper. This removes ~15 lines of copy-paste and makes future payload changes a single edit.

---

### Z12-04 — `stripLeadingMention` duplicated (medium / duplication)

`normalize.ts:83-85`:

```ts
function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/u, '').trim();
}
```

`thread.ts:44-46`:

```ts
function stripLeadingMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/u, '').trim();
}
```

The regex, flags, and trim call are identical. Even the names are slightly different (`stripMention` vs `stripLeadingMention`), hiding the duplication.

**Recommendation:** Move one copy to a shared `utils.ts` (or inline into `normalize.ts` and re-export) under the canonical name `stripLeadingMention`, then import it in both `normalize.ts` and `thread.ts`. The mpim-specific `stripBotMention` in `normalize.ts` (which strips any occurrence, not just leading) is distinct and should stay.

---

### Z12-05 — `mapSlackError` leaks as public API (medium / type-safety)

`client.ts:488` exports `mapSlackError`, and `index.ts:5` re-exports everything from `client.ts` (`export * from './client.js'`), so `mapSlackError` is part of the public package surface. However, it is an internal translation utility for converting raw Slack SDK errors; callers should receive the already-mapped `SlackActionError` and never need to call the mapper themselves.

Currently nothing outside the package imports `mapSlackError`, but surfacing it invites misuse and creates a commitment to its signature. `withSlackRetries` is legitimately public (the app-layer `WebApiSlackClient` wraps each call with it). `mapSlackError` is not.

**Recommendation:** Either remove the `export` keyword from `mapSlackError` (making it private to the module), or add a named re-export list in `index.ts` instead of using `export *` so internal helpers can be excluded. The `export *` pattern is convenient but sacrifices surface control.

---

### Z12-06 — `splitForBlocks` not directly tested (low / testing)

`blocks.ts:130` exports `splitForBlocks` as a public, standalone function. It contains non-trivial split logic (prefers paragraph break, then newline, then space, falls back to hard cut). The `markdownBlocks` tests exercise it indirectly for the chunking and truncation cases, but:

- The paragraph-break preference path is not tested in isolation.
- The `cut < max * 0.5` guard (which prevents a sub-half split) is exercised incidentally but not asserted directly.

**Recommendation:** Add direct tests for `splitForBlocks` in `tests/blocks.test.ts`: (a) paragraph boundary preference, (b) newline fallback, (c) space fallback, (d) hard cut on no whitespace. Since `splitForBlocks` is already exported, no source change is needed.

---

### Z12-07 — `usersList` missing `status_text`/`status_emoji` fields (low / consistency)

This finding is cross-zone (the implementation lives in `apps/agent/src/slack-client.ts`, zone Z05), but it affects the `SlackUserProfile` contract defined in this zone.

`usersInfo` correctly maps `profile.status_text` and `profile.status_emoji` to `statusText`/`statusEmoji`. `usersList`'s inline `UsersListResponse.members[].profile` type (`slack-client.ts:387`) is defined as `{ display_name?: string; real_name?: string; title?: string }` — it omits `status_text` and `status_emoji`. Since `usersList` is used as the boot-time name cache, status fields are never populated from it.

**Recommendation:** In `apps/agent/src/slack-client.ts`, add `status_text?: string; status_emoji?: string` to the `UsersListResponse` profile inline type, then map them to `statusText`/`statusEmoji` in the `members.map` block — identical to `usersInfo`.

---

### Z12-08 — Misleading JSDoc on `assistantThreadContextChanged` (low / docs)

`normalize.ts:313-317`:

```ts
/**
 * ...
 * Reuses the `AssistantThreadStarted` interface — both lifecycle events share the same shape.
 */
```

This comment correctly notes the shared shape but the explanation ("lifecycle events share the same shape") is insufficient for an OSS reader who needs to understand WHY — specifically, that Slack's `assistant_thread_context_changed` carries an identical `assistant_thread` object as `assistant_thread_started`. The current comment reads like a justification for the duplication rather than an explanation of the domain model.

**Recommendation:** After Z12-03 (extracting the shared helper), the JSDoc naturally simplifies: document that both events have the same `assistant_thread` structure per the Slack API spec.

---

### Z12-09 — `ActionsBlock.elements` typed as `unknown[]` (low / type-safety)

`blocks.ts:52-54`:

```ts
export interface ActionsBlock {
  type: 'actions';
  elements: unknown[];
}
```

The only action element currently emitted is a `urlButton` return type (`{ type: 'button'; text: PlainTextElement; url: string }`). The `urlButton` return type is an inline object type, not a named exported type.

**Recommendation:** Introduce a named `UrlButtonElement` interface (the current `urlButton` return type), change `ActionsBlock.elements` to `UrlButtonElement[]`, and update `actionsBlock` accordingly. This tightens the contract without breaking current callers, since only `urlButton` elements are ever inserted.

---

### Z12-10 — Off-by-one comment on retry loop (low / consistency)

`client.ts:450`:

```ts
while (attempt <= maxRetries) {
```

With `maxRetries = 3` (the default) and `attempt` starting at 0, this loop runs attempts 0, 1, 2, 3 — four total attempts (the initial call + three retries). The function signature says "Maximum number of retry attempts (default 3)" which is correct. But the unreachable throw after the loop (`/* istanbul ignore next — unreachable after exhausting retries */`) is misleading because the last-attempt throw happens INSIDE the loop at `if (attempt === maxRetries) { throw mapSlackError(err); }`. The post-loop throw is genuinely dead code.

**Recommendation:** Remove the unreachable post-loop throw (it is already tagged with `istanbul ignore`), or keep it but add a comment making explicit that `attempt === maxRetries` always throws inside the loop on the last iteration. The confusing part is purely cosmetic.

---

### Z12-11 — `VerifyResult` type not exported (low / naming)

`verify.ts:9`:

```ts
type VerifyResult = { ok: true } | { ok: false; reason: 'invalid_signature' | 'stale_timestamp' };
```

`verifySlackSignature` returns this type, but it is not exported. Callers who want to type a variable holding the result must use `ReturnType<typeof verifySlackSignature>` or `Awaited<…>`. For an OSS project this is a DX friction — a newcomer looking at the function signature sees the union but cannot import the name.

**Recommendation:** Export `VerifyResult` (or rename to `SlackVerifyResult` for namespace clarity). No runtime change needed.

---

### Z12-12 — `splitForBlocks` is unnecessarily public (low / dead-code)

`blocks.ts:130` exports `splitForBlocks` but the function is only called internally by `markdownBlocks` and is not imported anywhere else in the codebase. Public exports are a commitment — removing or changing them later is a breaking change for external consumers.

**Recommendation:** Either (a) remove the `export` and leave it as an internal helper (preferred), or (b) add a direct unit test to justify its public status. Recommendation (a) aligns with the package's purpose as a boundary-internal renderer; callers compose via `markdownBlocks`, not the chunking primitive.

---

### Z12-13 — Missing module-level doc comments (low / docs)

`render.ts:1-9` has a thorough module-level comment explaining the render-intent pipeline. The other modules lack equivalent descriptions:

- `thread.ts` — heading comment block is present (`// Slack thread → kernel history`) but not a JSDoc (`/** */`) module comment.
- `receipt.ts` — no module comment at all.
- `verify.ts` — no module comment.
- `blocks.ts` — has a comment block but it is a convention banner (`// --- Slack Block Kit typed builders ---`), not a module description.

For an OSS project the convention should be uniform: each module should open with a `/** … */` doc comment (or a structured `// -----------` banner with explanation, as in `normalize.ts` sections) explaining the module's responsibility and its consumer contract.

**Recommendation:** Add brief `/** … */` module doc comments to `receipt.ts`, `verify.ts`, and `thread.ts`. Optionally upgrade `blocks.ts` to match.

---

## Proposed Chunks

### C1 — Remove stale dist artifact and tighten `blocks` types (Z12-01, Z12-02, Z12-09, Z12-12)

**Goal:** The dist directory only contains built output that corresponds to current source; `blocks` interface contracts are fully typed.

1. Delete `dist/dedup.{js,d.ts,js.map,d.ts.map}`.
2. Add a `"clean": "rm -rf dist"` script and wire it as `prebuild`.
3. Replace `blocks?: unknown[]` with `blocks?: SlackBlock[]` in the three param interfaces in `client.ts`.
4. Introduce `UrlButtonElement` interface and tighten `ActionsBlock.elements`.
5. Remove `export` from `splitForBlocks` (internal helper only).
   **Depends on:** nothing.

---

### C2 — Eliminate duplication: `assistantThread*` + `stripLeadingMention` (Z12-03, Z12-04)

**Goal:** No copy-pasted code across `normalize.ts` and `thread.ts`.

1. Extract private `extractAssistantThread(raw, eventType)` helper; make the two public functions one-liners.
2. Move `stripLeadingMention` regex to a shared location (e.g. inline in `normalize.ts` exported as `stripLeadingMention`) and import it in `thread.ts`.
   **Depends on:** C1 (clean build baseline).

---

### C3 — Fix public API surface (Z12-05, Z12-11)

**Goal:** The exported package surface is intentional — internal utilities are private, result types are importable.

1. Remove `export` from `mapSlackError` (or switch `index.ts` to named re-exports).
2. Export `VerifyResult` (renamed to `SlackVerifyResult` for namespace clarity).
   **Depends on:** C2.

---

### C4 — Test and documentation polish (Z12-06, Z12-08, Z12-10, Z12-13)

**Goal:** All public exports have direct tests; module doc comments are uniform.

1. Add direct `splitForBlocks` test cases (paragraph/newline/space/hard-cut).
2. Remove the unreachable post-loop throw in `withSlackRetries` (or add clarifying comment).
3. Add `/** … */` module doc to `receipt.ts`, `verify.ts`, `thread.ts`.
4. Update `assistantThreadContextChanged` JSDoc to explain the shared shape rationale (post-C2).
   **Depends on:** C3.
