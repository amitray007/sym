# Zone Z07: Pi agent loop

## Summary

The Pi agent loop zone (`apps/agent/src/pi/`) is generally well-structured and shows clear design intent: a thin bridge layer (`tools.ts`, `meta-tools.ts`) wires Sym's tool registry into Pi's `AgentTool[]`, a bespoke conversation converter (`toAgentMessages`) translates Sym's `ChatMessage[]` into Pi's format, and the orchestrating `runLoopPi` function handles streaming, tool events, confirmation gating, and receipt assembly. The files are legibly commented, the public interface contracts are well-typed, and the test suite covers the major behavioral boundaries. That said, at 734 lines `loop.ts` has grown into a multi-responsibility file that mixes model construction, history conversion, tool wiring, confirmation logic, the guard-verdict cache, event subscriber logic, and the keepalive/whimsy concern — all in a single function with no internal decomposition. There are also a handful of genuine correctness gaps: `isError` is hardcoded `false` for all history tool-result messages, `toAgentMessages` drops tool-call content blocks from assistant messages (acknowledged TODO, but materially degrades multi-step history fidelity), the `AbortSignal` event listener is never removed (potential memory leak), `WHIMSY_WORDS` and `nextWhimsicalStatus` are internal loop details that leak into `handle-turn.ts`, `searchDescriptors` and `searchCli` share identical scored-term-overlap logic that is never unified, the `think-router`'s third branch always returns `'low'` making the branch unreachable, `SYM_CLI_CONFIRM` is read directly via `process.env` inside the loop (coupling the loop to env layout), and the env var itself is missing from `.env.example`. The zone is broadly sound — structural and minor correctness issues are the main concerns, not fundamental design mistakes.

---

## Findings

| ID     | Severity | Category       | Title                                                                                                                                                                | Files                              | Effort  |
| ------ | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------- |
| Z07-01 | high     | structure      | `runLoopPi` is one ~350-line function mixing 7 concerns                                                                                                              | loop.ts:387–734                    | medium  |
| Z07-02 | high     | type-safety    | `isError: false` hardcoded in `toAgentMessages` — history tool errors invisible to model                                                                             | loop.ts:189                        | small   |
| Z07-03 | medium   | type-safety    | `toAgentMessages` drops tool-call content blocks from assistant history (TODO chunk 3)                                                                               | loop.ts:131–198                    | medium  |
| Z07-04 | medium   | dead-code      | `pickThinkingLevel` third branch is unreachable — always returns `'low'`                                                                                             | think-router.ts:76–78              | trivial |
| Z07-05 | medium   | type-safety    | Three `prepareArguments: (args) => args as any` bypasses across tools.ts and meta-tools.ts                                                                           | tools.ts:53, meta-tools.ts:161,239 | small   |
| Z07-06 | medium   | duplication    | `searchDescriptors` and `searchCli` are identical scored term-overlap algorithms                                                                                     | meta-tools.ts:88–127               | small   |
| Z07-07 | medium   | naming         | `WHIMSY_WORDS` / `nextWhimsicalStatus` are loop internals leaking into `handle-turn.ts` public surface                                                               | loop.ts:354–372, handle-turn.ts:14 | small   |
| Z07-08 | medium   | type-safety    | Multiple `as Record<string, unknown>` casts on `context.args` (not narrowed before use)                                                                              | loop.ts:544,594                    | small   |
| Z07-09 | low      | dead-code      | `ThinkingLevel = 'low' \| 'medium' \| 'high'` — `'high'` never emitted; no caller can pass it                                                                        | think-router.ts:23                 | trivial |
| Z07-10 | low      | performance    | `resolveCliCapabilities()` and `resolveAllowlist()` called separately and both called on every turn                                                                  | loop.ts:451,469                    | trivial |
| Z07-11 | low      | error-handling | `AbortSignal.addEventListener('abort', …)` listener is never removed after `agent.prompt()` settles                                                                  | loop.ts:688–695                    | trivial |
| Z07-12 | low      | config         | `SYM_CLI_CONFIRM` read directly via `process.env` in the loop body — not in `.env.example`                                                                           | loop.ts:562                        | trivial |
| Z07-13 | low      | type-safety    | `buildFireworksModel` casts runtime `modelId` string through `unknown` to a hardcoded literal type                                                                   | model.ts:44                        | small   |
| Z07-14 | low      | docs           | `toAgentMessages` TODO comment says "chunk 3" — stale chunk reference, no tracker link                                                                               | loop.ts:131,158                    | trivial |
| Z07-15 | low      | type-safety    | `text: turn.text` in `pickThinkingLevel` call uses the pre-rewrite turn text (with raw `<@U…>` markup), which can trigger or suppress heuristics incorrectly         | handle-turn.ts:487                 | small   |
| Z07-16 | low      | consistency    | `groupByConnector` is a private function called from three public exports but re-implements the same `sep`/`local` splitting logic already in `partitionDescriptors` | meta-tools.ts:47–57                | trivial |
| Z07-17 | low      | testing        | `toAgentMessages`, `extractUsage`, `normalizeAnthropicBaseUrl`, and the abort-signal wiring path have zero test coverage                                             | loop.ts, model.ts                  | small   |

---

## Detail

### Z07-01 — `runLoopPi` is one ~350-line function mixing 7 concerns

**Severity:** high | **Category:** structure

`runLoopPi` at `loop.ts:387` spans to the end of the file (347 lines). It handles: (1) `ToolRuntimeContext` construction, (2) history conversion via `toAgentMessages`, (3) tool wiring (`bridgeTools`, `makeFindTools`, `makeCallTool`), (4) system-prompt assembly, (5) confirmation logic (`confirmMcp`, `beforeToolCall`), (6) `Agent` construction and `agent.subscribe()`, and (7) the post-run result collection and `Receipt` assembly. The `beforeToolCall` closure alone is 98 lines (lines 505–602). This makes it difficult to follow the linear control flow, and it makes each concern hard to unit-test independently.

**Recommendation:** Extract at minimum: (a) a `buildToolArray(...)` helper that takes registry/descriptors/cliCaps/context/confirm/onRender and returns `AgentTool[]`; (b) a `buildAgentSystemPrompt(mcpDescriptors, cliCaps)` helper; (c) the `beforeToolCall` closure into a named inner function with its own narrower parameter type. The event subscriber block (lines 636–685) could also be a named `makeSubscriber(...)` factory.

---

### Z07-02 — `isError: false` hardcoded in `toAgentMessages`

**Severity:** high | **Category:** type-safety

At `loop.ts:189`:

```typescript
out.push({
  role: 'toolResult' as const,
  toolCallId: msg.toolCallId ?? '',
  toolName: msg.name ?? '',
  content: [{ type: 'text', text: msg.content ?? '' }],
  isError: false, // ← always false
  timestamp: ts++,
});
```

Sym's `ChatMessage` for role `'tool'` can carry an error result (when a prior tool in a multi-turn session failed). Setting `isError: false` unconditionally means the model sees the error text but treats it as a success. This can confuse the model's recovery reasoning: if the prior turn had a failing tool call, it won't understand why.

**Recommendation:** Sym's `ChatMessage` should expose an `isError?: boolean` field (add to `@sym/contracts`), or the loop should inspect `msg.content` for an `[error_code]` prefix pattern to set `isError` correctly. As an interim fix: at minimum add a `// FIXME: should propagate msg.isError when ChatMessage carries it` comment so the gap is visible.

---

### Z07-03 — `toAgentMessages` drops tool-call content blocks from assistant history

**Severity:** medium | **Category:** type-safety

`loop.ts:131–158` acknowledges that assistant messages in history are converted to text-only stubs, omitting any `toolCall` content blocks:

```typescript
// TODO(pi): chunk 3 — include toolCall content blocks for full fidelity.
const assistantMsg: AssistantMessage = {
  content: msg.content != null ? [{ type: 'text', text: msg.content }] : [],
  ...
};
```

When the prior turn had interleaved tool calls (the common case with gpt-oss-120b), the model's history is missing the tool-call/tool-result round trips. The model sees a turn where it responded with prose but no record of which tools it called. This impairs its ability to avoid re-calling the same tools when following up in a multi-turn thread.

**Recommendation:** Sym's `ChatMessage` for role `'assistant'` should carry the original tool-call blocks (serialized). Extend `ChatMessage` or add a `ChatAssistantMessage` variant in `@sym/contracts`. Until then, add a comment making the known fidelity gap explicit and its consequences clear, so the OSS reader understands why multi-step follow-ups may repeat tool work.

---

### Z07-04 — `pickThinkingLevel` third branch is unreachable

**Severity:** medium | **Category:** dead-code

`think-router.ts:76–78`:

```typescript
// Trivial — short, simple, at most one question.
if (len <= TRIVIAL_MAX_LEN && clauseCount === 0 && questionCount <= 1) {
  return 'low';
}

return 'low'; // ← same value, unreachable via any distinct path
```

If both `medium` and `trivial` conditions are false (e.g. message is long with 0 clauses and 0 questions), the function falls through to the final `return 'low'`. But this final branch returns the same value as the trivial branch — it was presumably intended as a `return 'medium'` default for moderate-length messages, but was changed to `'low'` and the `if` guard above was not widened to match. The result is that `pickThinkingLevel` never returns `'medium'` for long messages with no deliberation cues.

**Recommendation:** Either widen the `trivial` branch to `return 'low'` unconditionally (remove the dead `if`) or assign `'medium'` to the fallthrough for messages that are long but not deliberative. Document the actual intended behavior clearly; the comment says "default → low" but the code comment at the top says the router routes between `low` and `medium`.

---

### Z07-05 — `prepareArguments: (args) => args as any` in three places

**Severity:** medium | **Category:** type-safety

`tools.ts:53`, `meta-tools.ts:161`, `meta-tools.ts:239` all use:

```typescript
prepareArguments: (args: unknown) => args as any,
```

This is documented as bypassing Pi's TypeBox runtime validation. While the intent is reasonable (Sym validates internally), the pattern proliferates `any` across the bridge and suppresses TypeScript checks on the prepared args. The `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comments on each call confirm this is known.

**Recommendation:** Extract the bypass to a single typed helper `const passthrough = (args: unknown): unknown => args` and use it in all three places. This avoids `any` while preserving the passthrough semantic. If/when Pi stabilizes its validation surface, there's one place to update.

---

### Z07-06 — `searchDescriptors` and `searchCli` are duplicate scored term-overlap algorithms

**Severity:** medium | **Category:** duplication

`meta-tools.ts:88–127`:

```typescript
export function searchDescriptors(
  mcp: ToolDescriptor[],
  query: string,
  limit: number,
): ToolDescriptor[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return mcp.slice(0, limit);
  const scored = mcp
    .map((d) => {
      const hay = `${d.name} ${d.description ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.d);
}

export function searchCli(cli: CliCapability[], query: string, limit: number): CliCapability[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return cli.slice(0, limit);
  const scored = cli
    .map((c) => {
      const hay = `${c.bin} ${c.description ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}
```

The bodies are structurally identical — term extraction, empty-query fast path, score computation, filter, sort, slice. Only the haystack projection differs.

**Recommendation:** Extract a generic `rankByTerms<T>(items: T[], hayOf: (item: T) => string, query: string, limit: number): T[]` helper and implement both functions in terms of it.

---

### Z07-07 — `WHIMSY_WORDS` / `nextWhimsicalStatus` leak loop internals into `handle-turn.ts`

**Severity:** medium | **Category:** naming

`handle-turn.ts:14` imports `nextWhimsicalStatus` and `WHIMSY_WORDS` directly from `loop.ts`. These are implementation details of the loop's keepalive mechanism:

```typescript
// handle-turn.ts:600
const whimsyPhrases = new Set([...WHIMSY_WORDS.map((w) => `is ${w}…`), `is ${openerPhrase}…`]);
const openerLoadingMessages = [openerStatus, ...WHIMSY_WORDS.slice(0, 9).map((w) => `is ${w}…`)];
```

`handle-turn.ts` is reaching inside `loop.ts` to compute a deduplication set and a Slack `loadingMessages` array. This creates coupling: any change to the whimsy vocabulary in `loop.ts` must be coordinated with the set-building logic in `handle-turn.ts`.

**Recommendation:** Export a single `buildOpenerLoadingMessages(openerPhrase: string): string[]` helper from `loop.ts` (or from a new `thinking-copy.ts` — the file that already hosts `pickShimmerPhrase` / `pickShimmerStatus`). The `whimsyPhrases` deduplication set and `openerLoadingMessages` array are both derived from the same words; one function returning both would remove the coupling.

---

### Z07-08 — Multiple `context.args as Record<string, unknown>` casts without narrowing

**Severity:** medium | **Category:** type-safety

`loop.ts:544` and `loop.ts:594`:

```typescript
args: (context.args ?? {}) as Record<string, unknown>,
```

`BeforeToolCallContext.args` is typed as `unknown` or some union in pi-agent-core. Casting to `Record<string, unknown>` without narrowing is safe for the downstream `requestConfirmation` call only because that function accepts `Record<string, unknown>`. However, this pattern bypasses the type checker silently — if Pi's `context.args` type changes, the cast would mask the incompatibility.

**Recommendation:** Add a narrow-and-cast helper:

```typescript
function toRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
```

Replace both cast sites with `toRecord(context.args)`.

---

### Z07-09 — `ThinkingLevel` includes `'high'` but no code ever emits it

**Severity:** low | **Category:** dead-code

`think-router.ts:23`:

```typescript
export type ThinkingLevel = 'low' | 'medium' | 'high';
```

The type union includes `'high'`, the JSDoc comment says `'high' is reserved — not emitted today`, and `pickThinkingLevel` never returns `'high'`. No caller passes `'high'` either. This is a speculative type member with no current usage.

**Recommendation:** Either remove `'high'` from the union until there is a concrete use case, or if the intent is to reserve the slot for a future explicit opt-in (e.g. `/think hard`), document it more prominently with a `// FUTURE` comment explaining the planned trigger. The current comment is buried mid-JSDoc and easy to miss.

---

### Z07-10 — `resolveCliCapabilities()` and `resolveAllowlist()` called twice per turn

**Severity:** low | **Category:** performance

`loop.ts:451,469`:

```typescript
const cliCaps = resolveCliCapabilities();
// ...
const cliCatalog = buildCliCatalog(resolveAllowlist(), cliCaps);
```

`buildCliCatalog` calls `resolveAllowlist()` internally, meaning `resolveAllowlist()` is called twice: once implicitly inside `buildCliCatalog`, once to get `cliCaps`. Both functions read from config files / `process.env` on each call. The work is cheap (file reads are tiny), but it's redundant and implies no caching.

**Recommendation:** Hoist the two calls together and pass the allowlist explicitly: `const allowlist = resolveAllowlist(); const cliCaps = resolveCliCapabilitiesFrom(allowlist);`. Or accept that the cost is trivial and add a comment acknowledging the intentional double-read.

---

### Z07-11 — `AbortSignal` listener is never removed

**Severity:** low | **Category:** error-handling

`loop.ts:688–695`:

```typescript
if (opts.signal) {
  opts.signal.addEventListener('abort', () => {
    agent.abort();
  });
}
```

The anonymous arrow function is added to the signal but never removed via `removeEventListener`. If the same `AbortSignal` is reused across turns (e.g. a single controller governing a stream) and the agent reference is garbage-collectable, the stale closure holds a live reference and `agent.abort()` can be called on a completed agent from a previous turn.

**Recommendation:** Store the handler reference and call `opts.signal.removeEventListener('abort', handler)` in a `finally` block, or use `{ once: true }` if the abort is expected to fire at most once per signal.

---

### Z07-12 — `SYM_CLI_CONFIRM` read directly via `process.env` in the loop; missing from `.env.example`

**Severity:** low | **Category:** config

`loop.ts:562`:

```typescript
const cliConfirm = /^(1|true|yes|on)$/i.test(process.env['SYM_CLI_CONFIRM'] ?? '');
```

This env var is the only runtime knob that is (a) read directly inside the Pi loop rather than through a `BehaviorConfig` struct, and (b) absent from `.env.example`. The project's behavior configuration pattern (see `config.ts` and `BehaviorConfig`) consolidates these reads at boot time. Reading `process.env` inside a hot turn path is a mild inconsistency and a documentation gap.

**Recommendation:** Add `SYM_CLI_CONFIRM` to `BehaviorConfig` (alongside `taskCardThreshold`, `ownerPostMarker`, etc.), thread it through `HandleTurnDeps.behavior`, and document it in `.env.example`. This makes all behavior knobs visible in one place.

---

### Z07-13 — `buildFireworksModel` casts runtime string through `unknown` to a hardcoded literal type

**Severity:** low | **Category:** type-safety

`model.ts:44`:

```typescript
const known = getModel(
  'fireworks',
  cfg.modelId as unknown as 'accounts/fireworks/models/gpt-oss-120b',
);
```

`getModel` is typed to accept a union of known model ID literals. The cast works at runtime but silences the type-system guard: if `cfg.modelId` is a string that `getModel` does not recognise, `known` is `undefined` and the subsequent `if (!known) throw` catches it at runtime. The null-check right after rescues correctness, but the cast pattern is misleading — it implies the caller has verified the type when it hasn't.

**Recommendation:** If `getModel` has a runtime-safe overload that accepts `string` (or can be called with a narrowed type check), use that. If not, keep the cast but add a comment explaining that the `if (!known) throw` immediately below is the real type guard, making the cast a necessary adapter for Pi's strict typing.

---

### Z07-14 — Stale `// TODO(pi): chunk 3` and `// TODO(pi): chunk 3.5` comments

**Severity:** low | **Category:** docs

`loop.ts:131,158` and `tools.ts:14,48`:

```typescript
// TODO(pi): chunk 3 — for assistant messages that include tool calls, emit
// the ToolCall content blocks so Pi's context window sees the full tool round-trip.
```

```typescript
// TODO(pi): chunk 3.5 — if Pi adds strict TypeBox runtime validation and
// rejects plain JSON Schema, migrate to Type.Unsafe(descriptor.parameters) here.
```

"Chunk 3" and "chunk 3.5" are internal planning references from the MCP client rollout plan. For an OSS audience these are opaque; they look like leftover tracking references with no link to an issue tracker or PR. The "chunk 3" TODO describes a real correctness gap (Z07-03 above).

**Recommendation:** Replace plan-internal references with issue-style comments: `// TODO: include tool-call content blocks for multi-step history fidelity — see Z07-03`. Link to a GitHub issue when the repo goes public.

---

### Z07-15 — `pickThinkingLevel` called with pre-rewrite `turn.text` (raw Slack markup)

**Severity:** low | **Category:** type-safety

`handle-turn.ts:487`:

```typescript
const thinkingLevel = pickThinkingLevel({
  text: turn.text, // ← raw, pre-rewrite
  threadDepth: history.length,
});
```

This is called from `runTurnLoop`, which receives `rewrittenTurn` as its `turn` argument. However, `turn.text` here refers to the parameter passed into `runTurnLoop`, which is `rewrittenTurn.text` (after `<@U…>` mentions are resolved). Looking at the call site at `handle-turn.ts:1028`:

```typescript
const reply = await runTurnLoop(rewrittenTurn, deps, registry, history);
```

So on the non-streaming path `turn.text` IS the rewritten text. But on the streaming path (`streamReply → runTurnLoop` at line 758) the `turn` passed in is also `rewrittenTurn`. The issue is subtle: `pickThinkingLevel`'s `DELIBERATIVE_PATTERN` and `CLAUSE_PATTERN` could be tripped differently depending on whether `<@U…>` tokens (which contain no clause connectives) inflate the character count. In practice the effect is minor, but raw markup in the router input could affect the `TRIVIAL_MAX_LEN = 40` threshold for short messages.

**Recommendation:** Document in `pickThinkingLevel`'s JSDoc that the caller should pass mention-resolved text. The contract is implicit today.

---

### Z07-16 — `groupByConnector` re-implements the same `sep`/`local` splitting already in `partitionDescriptors`

**Severity:** low | **Category:** consistency

`meta-tools.ts:47–57` (`groupByConnector`):

```typescript
const sep = d.name.indexOf(MCP_TOOL_SEPARATOR);
const connector = sep > 0 ? d.name.slice(0, sep) : d.name;
const local = sep > 0 ? d.name.slice(sep + MCP_TOOL_SEPARATOR.length) : d.name;
```

`partitionDescriptors` at line 41 already does a `d.name.includes(MCP_TOOL_SEPARATOR)` check. The logic for splitting `<server>__<tool>` is independently reimplemented in `groupByConnector`. If the separator format ever changes, both places need updating.

**Recommendation:** Extract a small `parseMcpName(name: string): { connector: string; local: string }` helper that both functions use. This also makes the "what is a connector name" rule a single authoritative location.

---

### Z07-17 — `toAgentMessages`, `extractUsage`, `normalizeAnthropicBaseUrl`, and abort-signal wiring untested

**Severity:** low | **Category:** testing

The existing `pi-loop.test.ts` covers the event subscriber (phantom tool filter, writing-status guard) and `friendlyVerb`/`nextWhimsicalStatus`. The following internal behaviors have no tests:

- `toAgentMessages`: the `role:'system'` drop, the `role:'tool'` → `'toolResult'` conversion, and the monotonic timestamp assignment.
- `extractUsage`: summing across multiple assistant messages.
- `normalizeAnthropicBaseUrl`: the trailing `/v1` stripping logic in `model.ts` (there is one test indirectly via `buildFireworksModel` mock in `slack-guard.test.ts`, but no direct boundary test for the URL normalization).
- `opts.signal` → `agent.abort()` wiring.

**Recommendation:** Add focused unit tests for each of these in `tests/pi-loop.test.ts` (and a small `tests/pi-model.test.ts` for the URL normalizer). These are pure functions with no I/O — they are straightforward to test.

---

## Proposed chunks

### C1: Unify duplicate search logic in meta-tools (Z07-06, Z07-16)

**Goal:** `meta-tools.ts` has one `rankByTerms<T>` generic, one `parseMcpName` helper; `searchDescriptors` and `searchCli` are thin wrappers. Green tests confirm.  
**Depends on:** nothing.

### C2: Remove unreachable branch in think-router + harden ThinkingLevel type (Z07-04, Z07-09)

**Goal:** `pickThinkingLevel` has no dead third branch. `ThinkingLevel` either drops `'high'` or documents its reservation with a concrete trigger. Tests updated to reflect.  
**Depends on:** nothing.

### C3: Fix `isError` hardcoding and `toAgentMessages` fidelity gap (Z07-02, Z07-03, Z07-14)

**Goal:** `ChatMessage` carries `isError` for tool-result messages; `toAgentMessages` propagates it. The tool-call content TODO is either implemented or re-documented as a tracked issue. Tests for `toAgentMessages` in `pi-loop.test.ts`.  
**Depends on:** nothing (if only fixing `isError`); requires `@sym/contracts` update (if adding `isError` field to `ChatMessage`).

### C4: Harden `as any` / `as Record` casts across tools.ts and meta-tools.ts (Z07-05, Z07-08)

**Goal:** Zero `as any` in the zone. `prepareArguments` uses a named `passthrough` helper. `context.args` is narrowed via a `toRecord()` helper before passing to `requestConfirmation`.  
**Depends on:** nothing.

### C5: Add `SYM_CLI_CONFIRM` to `BehaviorConfig` and `.env.example` (Z07-12)

**Goal:** The loop no longer reads `process.env` directly. All behavior knobs are threaded through `HandleTurnDeps.behavior`. `.env.example` documents the new key.  
**Depends on:** nothing.

### C6: Fix `AbortSignal` listener leak (Z07-11)

**Goal:** The abort listener is removed after `agent.prompt()` settles. Tests cover both the abort-fires and abort-does-not-fire paths.  
**Depends on:** nothing.

### C7: Decompose `runLoopPi` into focused named helpers (Z07-01, Z07-07, Z07-10)

**Goal:** `runLoopPi` is ≤150 lines. Named helpers: `buildAgentTools(...)`, `buildAgentSystemPrompt(...)`, `makeBeforeToolCall(...)`, `makeSubscriber(...)`. `WHIMSY_WORDS` / `nextWhimsicalStatus` exported from `thinking-copy.ts` (not `loop.ts`); `handle-turn.ts` imports from there. `resolveAllowlist` called once per turn.  
**Depends on:** C4, C6 (cleaner to decompose after those casts are resolved).

### C8: Add unit tests for untested zone internals (Z07-17, Z07-13)

**Goal:** `toAgentMessages`, `extractUsage`, `normalizeAnthropicBaseUrl`, and abort-signal wiring all have direct tests. `buildFireworksModel` URL-normalization has a dedicated boundary test.  
**Depends on:** C3 (for correct `isError` to test against).
