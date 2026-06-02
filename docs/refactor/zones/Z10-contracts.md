# Zone Z10: packages/contracts (shared types)

## Summary

`@sym/contracts` is a genuine shared-contract layer: its types are imported by `apps/agent`, `packages/adapter/slack`, and `packages/kernel` across at least 15 source files, fully justifying a separate package. The file decomposition is clean (one concept per file, all small), inline documentation is above average for an OSS codebase, and the type-level test harness (vitest `--typecheck` on `*.test-d.ts`) is the correct choice for a types-only package. However, the package has a notable set of aspirational/legacy types in `provider.ts` that are never consumed by any real code path (the codebase switched to `@earendil-works/pi-ai` as its provider abstraction, making `ProviderInterface`, `CompletionRequest`, `CompletionChunk`, `FinishReason`, and `ToolCallDelta` dead exports). The `dist/` directory contains stale compiled artifacts from deleted source files (`audit`, `connectors`, `memory`, `sandbox`, `soul`) that were never removed after the "collapse to stateless" refactor; they are harmless at runtime but create confusion during OSS onboarding. Minor issues include a redundant union member in `ToolSuccess.content`, an unexported `SymErrorBase` helper that limits extensibility, an inline literal `'task'` surface in `domain.ts` that is never populated, and sparse type-level test coverage for the render and tool contract surfaces.

---

## Findings

| ID     | Severity | Category    | Title                                                                                             | Files                                                                                 | Effort  |
| ------ | -------- | ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------- |
| Z10-01 | high     | dead-code   | Dead provider-abstraction types never consumed                                                    | `src/provider.ts`                                                                     | small   |
| Z10-02 | high     | dead-code   | Stale compiled dist artifacts from deleted features                                               | `dist/audit.*`, `dist/connectors.*`, `dist/memory.*`, `dist/sandbox.*`, `dist/soul.*` | trivial |
| Z10-03 | medium   | type-safety | `ToolSuccess.content: JsonValue \| string` is a redundant union                                   | `src/tools.ts:56`                                                                     | trivial |
| Z10-04 | medium   | dead-code   | `'task'` literal in `Turn.entrySurface` is never set in production                                | `src/domain.ts:20`                                                                    | trivial |
| Z10-05 | medium   | type-safety | `JsonSchema` index signature is overly broad and confusing                                        | `src/json.ts:23`                                                                      | small   |
| Z10-06 | medium   | structure   | `ReceiptFooterField` lives in `slack.ts` but is a domain presentation concept                     | `src/slack.ts:34-37`                                                                  | trivial |
| Z10-07 | medium   | testing     | Type-level tests cover 5 of ~20 exported shapes; render/tool/domain surfaces untested             | `tests/contracts.test-d.ts`                                                           | small   |
| Z10-08 | low      | type-safety | `SymErrorBase` is unexported; consumers cannot define new error domains without duplication       | `src/errors.ts:5-11`                                                                  | trivial |
| Z10-09 | low      | dead-code   | `ToolDescriptor.type: 'function'` is a no-op discriminant — every tool is a function              | `src/tools.ts:10`                                                                     | trivial |
| Z10-10 | low      | docs        | README layout section omits `packages/` entirely; contracts package is invisible to newcomers     | `README.md` (cross-ref)                                                               | trivial |
| Z10-11 | low      | config      | `package.json` has redundant legacy `"main"` and `"types"` top-level fields alongside `"exports"` | `package.json:9-10`                                                                   | trivial |

---

## Detail

### Z10-01 — Dead provider-abstraction types never consumed (high)

**Evidence:**

`src/provider.ts` exports `ProviderInterface`, `CompletionRequest`, `CompletionChunk`, `FinishReason`, and `ToolCallDelta`. A broad search across all source files (excluding `dist/` and worktrees) shows that none of these five types are imported by any real consumer:

```
# grep results for external imports:
packages/contracts/tests/contracts.test-d.ts:6:  import type { CompletionChunk, ProviderInterface }
# (only the type-level test; no production caller)
```

The real provider path is `@earendil-works/pi-ai`'s `Model<'anthropic-messages'>`, wired in `apps/agent/src/pi/model.ts` and `apps/agent/src/pi/loop.ts`. `ChatMessage` and `Usage` from this file ARE used (thread history and receipt accounting), but the five dead types are a residue of a provider-swap design that was superseded by the Pi SDK before it was ever consumed.

**Recommendation:** Remove `ProviderInterface`, `CompletionRequest`, `CompletionChunk`, `FinishReason`, and `ToolCallDelta` from `src/provider.ts`. Rename the file to `src/chat.ts` (its remaining contents — `ChatRole`, `ChatMessage`, `Usage` — are chat-message and usage-accounting types, not provider-abstraction types). Update `index.ts` accordingly.

---

### Z10-02 — Stale compiled dist artifacts from deleted features (high)

**Evidence:**

The `dist/` directory contains compiled output for source files that no longer exist in `src/`:

```
dist/audit.d.ts        (AuditEvent, HashChainEntry — deleted with the audit feature)
dist/connectors.d.ts   (Connector, ConnectorCredential, ConnectorOAuthConfig — deleted with connectors)
dist/memory.d.ts       (MemoryEntry, RetrievalGate — deleted with the memory feature)
dist/sandbox.d.ts      (SandboxIdentity, LeaseRef, EgressRequest — deleted with sandbox/egress)
dist/soul.d.ts         (SoulCascade, ToneRewriteResult — deleted with soul-layers feature)
```

The current `dist/index.d.ts` does NOT re-export any of these, so they are not visible via the package entry point and do not pollute the public type surface. However:

- A new contributor reading `dist/` will see types like `AuditEvent`, `OAuthTokenId`, `SandboxIdentity` and assume these are live concerns.
- The stale `.js` files are included in the npm `files: ["dist"]` glob, unnecessarily inflating the published package.
- `ids.ts` in the stale dist references branded IDs (`AuditEventId`, `MemoryId`, `McpConfigId`, `OAuthTokenId`, `SandboxId`, etc.) that are absent from the current `src/ids.ts`.

**Recommendation:** Delete all stale dist artifacts. The cleanest path is to add a `prebuildi`/`clean` script (`rimraf dist`) or run `tsc --build --clean` before each build so orphaned files are removed. Committing a `.gitignore` entry for `dist/` (if not already present) and rebuilding from scratch will also resolve this.

---

### Z10-03 — `ToolSuccess.content` is a redundant union (medium)

**Evidence (`src/tools.ts:56`):**

```ts
export interface ToolSuccess {
  callId: string;
  ok: true;
  content: JsonValue | string; // ← string is already JsonPrimitive ⊂ JsonValue
  render?: RenderIntent;
}
```

`JsonValue = JsonPrimitive | JsonValue[] | JsonObject`, and `JsonPrimitive = string | number | boolean | null`. So `string` is already a member of `JsonValue`; the `| string` is redundant and signals either an unresolved draft or a misunderstanding of the type.

**Recommendation:** Change to `content: JsonValue`. This is the correct type and removes the redundancy without breaking any callers (every valid `string` value still satisfies `JsonValue`).

---

### Z10-04 — `'task'` literal in `Turn.entrySurface` is never set (medium)

**Evidence (`src/domain.ts:20`):**

```ts
export interface Turn {
  entrySurface: SlackEntrySurface | 'task';
```

`SlackEntrySurface = 'app_mention' | 'dm' | 'shortcut' | 'slash_command'` (`src/slack.ts:13`). The `'task'` literal is documented as "kernel-internal, not a Slack entry point" but is never assigned anywhere in the codebase:

```
# grep results for entrySurface assigned 'task':
(no results outside of the type definition itself)
```

The only conditional on `entrySurface` in production code is `handle-turn.ts:702` which checks for `'slash_command'` only.

**Recommendation:** Remove `| 'task'` from `Turn.entrySurface`. If a task-triggered turn is ever introduced, add it then with a concrete implementation. Speculative union members in contracts cause confusing branches in consumer `switch` statements.

---

### Z10-05 — `JsonSchema` index signature is overly broad (medium)

**Evidence (`src/json.ts:23`):**

```ts
export interface JsonSchema {
  type?: 'object' | 'array' | ...;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: JsonValue[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: JsonValue | JsonSchema | Record<string, JsonSchema> | string[] | undefined;
}
```

The catch-all index signature `[key: string]: ...` is required by TypeScript when a known property's type must be assignable to the index type. But the resulting union is wide and opaque (`JsonValue | JsonSchema | Record<string, JsonSchema> | string[] | undefined`), making it difficult to extend cleanly. With `noPropertyAccessFromIndexSignature: true` in `tsconfig.base.json`, any indexed-access on `JsonSchema` via a variable key requires an explicit bracket notation, so the index signature serves mainly as a "pass-through unknown extras" escape hatch for forward-compatibility with JSON Schema keywords not modelled here.

The comment says "just enough to describe tool inputs to the provider", which is accurate, but the index signature is undocumented at the line level and will confuse contributors who expect clean property access.

**Recommendation:** Add an inline comment on the index signature explaining its purpose: "Allows forward-compatible JSON Schema keywords not explicitly modelled (e.g. `$defs`, `if/then`, `allOf`). The union is wide by necessity — TS requires index types to be a supertype of all explicit property types." This is low-risk but meaningfully improves clarity.

---

### Z10-06 — `ReceiptFooterField` lives in the wrong file (medium)

**Evidence (`src/slack.ts:34-37`):**

```ts
/** A diagnostic footer rendered as a Slack `context` block (outbound contract §3). */
export interface ReceiptFooterField {
  label: string;
  value: string;
}
```

`ReceiptFooterField` is a presentation DTO used to convert a `Receipt` into Slack-renderable label/value pairs. Its consumer is `packages/adapter/slack/src/receipt.ts:receiptToFooterFields()`. It is conceptually part of the receipt/domain layer (the `Receipt` type lives in `domain.ts`), not a Slack-specific concern. Its placement in `slack.ts` alongside the inbound event contracts (`SlackTurnInput`, `SlackEntrySurface`) is misleading.

**Recommendation:** Move `ReceiptFooterField` to `src/domain.ts` alongside `Receipt`. The Slack adapter imports it from `@sym/contracts` either way; only the internal organisation changes. Alternatively, if it is considered purely an adapter-internal presentation helper, move it to `packages/adapter/slack/src/receipt.ts` entirely and stop exporting it from contracts.

---

### Z10-07 — Type-level tests cover only 5 of ~20 exported shapes (medium)

**Evidence (`tests/contracts.test-d.ts`):**

Current coverage:

- Branded IDs are nominal (`WorkspaceId` vs `string`, `WorkspaceId` vs `SlackUserId`) ✓
- `ToolResult` is a discriminated union on `ok` ✓
- `ProviderInterface.complete` returns `AsyncIterable<CompletionChunk>` ✓ (tests a dead type)
- `Reply` carries a `Receipt` ✓
- `Result` narrows on `ok` ✓

Not covered by any type assertion:

- `RenderIntent` is a discriminated union (`TableRenderIntent | CardRenderIntent`) — no test
- `Turn.entrySurface` accepts `SlackEntrySurface` values — no test
- `SlackTurnInput` shape and required vs optional fields — no test
- `ChatMessage.content` can be `null` on tool-call-only assistant messages — no test
- `ToolDescriptor` shape (especially `readOnlyHint`/`destructiveHint`/`actor` optionality) — no test
- `ToolRuntimeContext` exposes `channelId` as optional — no test
- `Brand<T, B>` assignment to `T` (covariance) — tested, but inverse cast tested only for `WorkspaceId`; no test for Slack-specific brands (`SlackChannelId`, `SlackThreadTs`)

**Recommendation:** Expand `contracts.test-d.ts` with type assertions for the render union, the ChatMessage null-content rule, ToolRuntimeContext optionality, and at least one Slack-specific brand. Remove the `ProviderInterface` test case if the type is removed per Z10-01.

---

### Z10-08 — `SymErrorBase` is unexported (low)

**Evidence (`src/errors.ts:5-11`):**

```ts
interface SymErrorBase<D extends string, C extends string> {
  domain: D;
  code: C;
  message: string;
  retryable?: boolean;
  cause?: unknown;
}
```

`SymErrorBase` is private (no `export`). The current `SymError` union has exactly one member (`SlackActionError`). If a second error domain (e.g. `McpActionError`) is ever added, the package author will need to rediscover and either re-export or duplicate the base. Since this is the intended extension point for the union, hiding it creates unnecessary friction.

**Recommendation:** Export `SymErrorBase` so callers defining new domains can build on it: `export interface SymErrorBase<D extends string, C extends string> { ... }`.

---

### Z10-09 — `ToolDescriptor.type: 'function'` is a no-op discriminant (low)

**Evidence (`src/tools.ts:10`):**

```ts
export interface ToolDescriptor {
  type: 'function';
  name: string;
  ...
}
```

`type: 'function'` is a single-member literal — it cannot discriminate anything since there is no other member of any union that uses `ToolDescriptor`. Every usage in `builtin-tools.ts` sets `type: 'function'` verbatim without any conditional check. The field exists because the OpenAI chat-completions wire format wraps tool definitions as `{ type: 'function', function: { name, description, parameters } }`, but Sym's `ToolDescriptor` is an internal shape that does NOT follow that outer wrapper (it flattens the fields). The `type` field is therefore cargo-culted from the OpenAI spec without serving a real purpose in Sym's type system.

**Recommendation:** Remove `type: 'function'` from `ToolDescriptor`. If a future non-function tool kind (e.g. `type: 'retrieval'`) is needed, add a discriminated union at that point.

---

### Z10-10 — README layout section omits `packages/` entirely (low)

**Evidence (`README.md`):**

```
## Repository layout
apps/
  agent/    Hono server — Slack events → Pi agent loop → Fireworks reply
docs/
  FUTURE.md Parked features ...
```

The three packages (`@sym/contracts`, `@sym/kernel`, `@sym/adapter-slack`) that form the backbone of the architecture are completely absent. A first-time contributor cloning the repo has no way to discover `packages/` from the README.

**Recommendation:** Extend the layout section to list `packages/contracts`, `packages/kernel`, and `packages/adapter/slack` with one-line descriptions matching their module-level JSDoc comments.

---

### Z10-11 — Redundant legacy `"main"` and `"types"` fields in `package.json` (low)

**Evidence (`package.json:9-10`):**

```json
{
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts"
}
```

The `exports` map is the canonical entry point for Node ≥ 12 and all modern bundlers. The top-level `"main"` and `"types"` fields are fallbacks for tools that don't read `exports` (old Jest configurations, Webpack 4, etc.). This is a private monorepo where all consumers are controlled; none of these old fallbacks are needed. The redundancy risks divergence if one set is updated without the other.

**Recommendation:** Remove the top-level `"main"` and `"types"` fields and rely solely on the `"exports"` map. All other `@sym/*` packages in the monorepo should follow the same pattern.

---

## Proposed Chunks

### C1 — Trim dead provider-abstraction types and rename file (Z10-01, Z10-09)

**Goal:** Remove `ProviderInterface`, `CompletionRequest`, `CompletionChunk`, `FinishReason`, `ToolCallDelta` from `provider.ts`; rename it to `chat.ts` (retaining `ChatRole`, `ChatMessage`, `Usage`); remove `type: 'function'` from `ToolDescriptor`; update `index.ts`. Update any consumer imports (only `tests/contracts.test-d.ts` and `pi/loop.ts` reference these files; `loop.ts` only uses the retained types).
**Depends on:** nothing

### C2 — Fix trivial type correctness issues (Z10-03, Z10-04, Z10-08)

**Goal:** Change `ToolSuccess.content` to `JsonValue`; remove `| 'task'` from `Turn.entrySurface`; export `SymErrorBase`.
**Depends on:** C1 (to avoid touching the same file twice)

### C3 — Relocate `ReceiptFooterField` to `domain.ts` (Z10-06)

**Goal:** Move `ReceiptFooterField` from `slack.ts` to `domain.ts`. Update the single consumer (`packages/adapter/slack/src/receipt.ts`) — the import path stays `@sym/contracts` so no external change needed.
**Depends on:** C2 (minimise churn to domain.ts)

### C4 — Document `JsonSchema` index signature; clean up `package.json` (Z10-05, Z10-11)

**Goal:** Add an inline comment on the `JsonSchema` index signature; remove legacy `"main"` and `"types"` fields from `package.json`.
**Depends on:** nothing (can run in parallel with C1–C3)

### C5 — Expand type-level test coverage (Z10-07)

**Goal:** Add `test-d` assertions for `RenderIntent` discriminated union, `ChatMessage` null-content rule, `ToolRuntimeContext` optional `channelId`, and at least two Slack-specific brands; remove the now-dead `ProviderInterface` test.
**Depends on:** C1 (removes the ProviderInterface assertion being replaced)

### C6 — Delete stale dist artifacts; add clean step to build script (Z10-02)

**Goal:** Delete `dist/audit.*`, `dist/connectors.*`, `dist/memory.*`, `dist/sandbox.*`, `dist/soul.*`; add a `prebuild` script (`rimraf dist` or `tsc --build --clean`) so they cannot reappear.
**Depends on:** nothing

### C7 — Update README layout section (Z10-10)

**Goal:** Add `packages/contracts`, `packages/kernel`, `packages/adapter/slack` to the repo layout table with one-line descriptions.
**Depends on:** nothing
