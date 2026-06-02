# Zone Z11: packages/kernel

## Summary

`packages/kernel` is a small, tightly scoped package of three runtime modules: prompt assembly (`prompt.ts`), receipt construction (`receipt.ts`), and a tool-registry wrapper (`tools.ts`). The package boundary earns its keep — it provides compile-time-checked runtime primitives that the app layer calls without pulling in any Slack or Pi dependencies. The code is generally well-commented and readable. However several findings undermine the quality bar required for OSS launch: stale dist artifacts from deleted modules (`soul.ts`, `tone.ts`, `loop.ts`) sit alongside live source and will confuse newcomers; a visibility-logic gap in `buildTurnContextPrompt` silently mislabels `/sym` slash commands run from a DM as "SHARED" when they are effectively private; `OwnerIdentity` is a domain concept but lives inside `prompt.ts` rather than `@sym/contracts`; `buildTurnContextPrompt` and `ReceiptParams` are exported from the package surface but never consumed outside the package; `ToolRegistry.hasTools()` is defined but never called; and test coverage exists only for `prompt.ts`, leaving `receipt.ts` and `tools.ts` entirely untested. None of these findings individually break the runtime, but the stale dist and the visibility bug are the most pressing items before open-sourcing.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                            | Files                                                       | Effort  |
| ------ | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------- |
| Z11-01 | high     | dead-code   | Stale dist artifacts from deleted modules (soul, tone, loop)                                                                                     | `packages/kernel/dist/soul.*`, `dist/tone.*`, `dist/loop.*` | trivial |
| Z11-02 | high     | structure   | `OwnerIdentity` is a domain type stranded in `prompt.ts` instead of `@sym/contracts`                                                             | `packages/kernel/src/prompt.ts:9`                           | small   |
| Z11-03 | medium   | consistency | `buildTurnContextPrompt` visibility misclassifies slash-command-in-DM as SHARED                                                                  | `packages/kernel/src/prompt.ts:174–178`                     | small   |
| Z11-04 | medium   | dead-code   | `buildTurnContextPrompt` and `ReceiptParams` are exported from the package but never imported outside                                            | `packages/kernel/src/index.ts:1,4`                          | trivial |
| Z11-05 | medium   | dead-code   | `ToolRegistry.hasTools()` is defined and exported but never called anywhere                                                                      | `packages/kernel/src/tools.ts:23–25`                        | trivial |
| Z11-06 | medium   | testing     | `receipt.ts` and `tools.ts` have zero unit tests                                                                                                 | `packages/kernel/tests/`                                    | small   |
| Z11-07 | medium   | docs        | Reference to non-existent internal spec (`agent-prompt-spec §section-boundaries`)                                                                | `packages/kernel/src/prompt.ts:31`                          | trivial |
| Z11-08 | low      | complexity  | `buildSystemPrompt` is a 112-line flat array in one function — no section constants, hard to navigate                                            | `packages/kernel/src/prompt.ts:45–158`                      | medium  |
| Z11-09 | low      | testing     | `buildSystemPrompt` tests only check existence and stability — no coverage of required sections                                                  | `packages/kernel/tests/prompt.test.ts:23–41`                | small   |
| Z11-10 | low      | config      | `vitest.config.ts` sets a 20s test timeout for pure unit tests; 5s is sufficient                                                                 | `packages/kernel/vitest.config.ts:6–7`                      | trivial |
| Z11-11 | low      | naming      | Package name "kernel" is vague AI-generic — the package is actually "turn primitives" (prompt + receipt + tool registry)                         | `packages/kernel/package.json`                              | medium  |
| Z11-12 | low      | structure   | `IDENTITY` constant extracted from `buildSystemPrompt` with no doc explaining the motivation                                                     | `packages/kernel/src/prompt.ts:34–43`                       | trivial |
| Z11-13 | low      | dependency  | `packages/kernel` is a `private: true` workspace package but exports `ReceiptParams` as a type — a leaky type the caller (apps/agent) never uses | `packages/kernel/src/index.ts:4`                            | trivial |

---

## Detail

### Z11-01 — Stale dist artifacts from deleted modules (soul, tone, loop)

**Evidence.**  
`dist/` contains six files for modules that no longer exist in `src/`:

```
packages/kernel/dist/soul.js   soul.d.ts   soul.d.ts.map   soul.js.map
packages/kernel/dist/tone.js   tone.d.ts   tone.d.ts.map   tone.js.map
packages/kernel/dist/loop.js   loop.d.ts   loop.d.ts.map   loop.js.map
```

`soul.d.ts` declares `buildDefaultSoulCascade(): SoulCascade`, `tone.d.ts` declares `applyToneRewrite(...)`, and `loop.d.ts` declares the old `runLoop(...)` API — all referencing types (`SoulCascade`, `ToneRewriteResult`) that no longer exist in `@sym/contracts`. Neither is re-exported from `dist/index.d.ts`, so they cannot be imported. They are purely orphaned build outputs.

**Recommendation.**  
Delete the stale files:

```
rm packages/kernel/dist/soul.* packages/kernel/dist/tone.* packages/kernel/dist/loop.*
```

Then run `pnpm --filter @sym/kernel build` to regenerate a clean dist. Also add `dist/` to `.gitignore` for the package (or to the root `.gitignore`) to prevent future stale artifact commits. For an OSS reader, finding generated type declarations for functions that don't exist in source is deeply confusing.

---

### Z11-02 — `OwnerIdentity` is a domain type stranded in `prompt.ts`

**Evidence.**  
`OwnerIdentity` is defined at `packages/kernel/src/prompt.ts:9–23`. It is imported by `apps/agent/src/handle-turn.ts`, `apps/agent/src/owner-gate.ts`, `apps/agent/src/workspace-context.ts`, and `apps/agent/src/pi/loop.ts` — all via `import type { OwnerIdentity } from '@sym/kernel'`. Conceptually it is a domain object (owner name, tz, username) that would naturally sit alongside `Turn`, `Receipt`, and `Reply` in `@sym/contracts`.

Keeping it in `prompt.ts` means: (a) consumers must reach into `@sym/kernel` (a runtime package) for a pure-type import; (b) it is coupled to the prompt file even though it's used by `owner-gate.ts` and `workspace-context.ts` which have nothing to do with prompt construction.

**Recommendation.**  
Move `OwnerIdentity` to `packages/contracts/src/domain.ts` (alongside `Turn`, `Receipt`, `Reply`) and re-export it from `packages/contracts/src/index.ts`. Update `prompt.ts` to `import type { OwnerIdentity } from '@sym/contracts'` and update every consumer's import. This is a pure type move — no runtime change.

---

### Z11-03 — Visibility misclassifies slash-command-in-DM as SHARED

**Evidence.**  
`packages/kernel/src/prompt.ts:174–178`:

```ts
parts.push(
  turn.entrySurface === 'dm'
    ? 'visibility: PRIVATE (only the owner sees your reply)'
    : 'visibility: SHARED channel (others here can read your reply)',
);
```

The `Turn.entrySurface` for a `/sym` slash command is always `'slash_command'` (set in `packages/adapter/slack/src/normalize.ts:264`). When the command is run from a DM (where `channelId` starts with `D`), `isDm` is `true` in `server.ts`, and the response is sent as `response_type: 'ephemeral'` — meaning only the owner sees it. But the visibility string injected into the model context still says "SHARED channel", giving the model the wrong privacy framing.

The privacy guard in the system prompt (`## Your boundaries`) uses the `visibility: SHARED` signal to decide whether to surface the owner's private content. A false SHARED label could cause the model to unnecessarily withhold private information in a genuinely private context.

**Recommendation.**  
Broaden the private-visibility predicate to cover all surfaces where only the owner sees the reply:

```ts
const isPrivate = turn.entrySurface === 'dm' || turn.entrySurface === 'slash_command';
parts.push(
  isPrivate
    ? 'visibility: PRIVATE (only the owner sees your reply)'
    : 'visibility: SHARED channel (others here can read your reply)',
);
```

Then add a test case in `prompt.test.ts`:

```ts
it('marks a slash_command as PRIVATE visibility', () => {
  const ctx = buildTurnContextPrompt(makeTurn({ entrySurface: 'slash_command' }));
  expect(ctx).toContain('PRIVATE');
});
```

---

### Z11-04 — `buildTurnContextPrompt` and `ReceiptParams` exported but never consumed outside

**Evidence.**  
`packages/kernel/src/index.ts:1,4`:

```ts
export { buildSystemPrompt, buildTurnContextPrompt, buildUserTurnContent } from './prompt.js';
export type { ReceiptParams } from './receipt.js';
```

A search of all `.ts` files in the repo (excluding node_modules, dist, and `.claude/worktrees`) confirms that `buildTurnContextPrompt` is never imported from `@sym/kernel` outside the package itself — it is only called internally by `buildUserTurnContent` at `prompt.ts:223`. Similarly `ReceiptParams` is exported but never imported anywhere outside `kernel`.

**Recommendation.**  
Remove `buildTurnContextPrompt` from `index.ts` (make it non-exported). Remove the `ReceiptParams` re-export — callers only need `buildReceipt`. If a future caller needs to construct `ReceiptParams` independently, re-add the export then.

---

### Z11-05 — `ToolRegistry.hasTools()` defined but never called

**Evidence.**  
`packages/kernel/src/tools.ts:23–25`:

```ts
hasTools(): boolean {
  return this.listTools().length > 0;
}
```

A full search confirms `hasTools()` is never called anywhere in the codebase outside its own definition. Every call site either calls `registry.listTools()` directly or checks `allDescriptors.length > 0` on the returned array.

**Recommendation.**  
Delete `hasTools()`. It is dead convenience sugar. If a future caller needs it, adding it is trivial.

---

### Z11-06 — `receipt.ts` and `tools.ts` have zero unit tests

**Evidence.**  
`packages/kernel/tests/` contains only `prompt.test.ts`. `receipt.ts` (27 lines, one function) and `tools.ts` (31 lines, one class) have no test coverage. The convention stated in team guidelines is that every real feature needs a real-wire QA test — but at minimum, pure unit tests for pure functions should exist.

Key untested behaviors:

- `buildReceipt` — does it correctly omit `usage` and `durationMs` when undefined? Does it preserve `toolsInvoked: []` when the list is empty? Does it set `turnId` from the turn?
- `ToolRegistry` — null dispatcher → `listTools()` returns `[]`, `getDispatcher()` returns null. Non-null dispatcher → delegates correctly.

**Recommendation.**  
Add `packages/kernel/tests/receipt.test.ts` and `packages/kernel/tests/tools.test.ts` with basic coverage of the above behaviors. These are fast, pure unit tests — no mocking needed.

---

### Z11-07 — Dead reference to non-existent spec document

**Evidence.**  
`packages/kernel/src/prompt.ts:31`:

```ts
 * Per agent-prompt-spec §section-boundaries:
 *   buildSystemPrompt() must be static: no parameters, no runtime data.
```

No file matching `agent-prompt-spec` exists anywhere in the repo. The `§section-boundaries` section ID is undefined. This is a ghost reference, likely from an older internal design doc that was never committed. For an OSS reader this looks authoritative but leads nowhere.

**Recommendation.**  
Replace with a self-contained explanation:

```ts
 * Must remain static (no parameters, no runtime data) so the string is
 * byte-identical across calls — enabling provider prompt-prefix caching.
```

---

### Z11-08 — `buildSystemPrompt` is a 112-line flat string array

**Evidence.**  
`packages/kernel/src/prompt.ts:45–158`: The function body is a single array literal spanning 112 lines across 13 `##` sections, with no named section constants. Reading or editing any specific section requires scrolling through the entire function. There is no way to import or test individual sections in isolation.

The `IDENTITY` constant (`prompt.ts:34–43`) extracts the intro paragraph, but its extraction is unexplained by a comment, and the extraction pattern is not applied to any other section.

**Recommendation.**  
Extract each `##` section into a named `const` alongside `IDENTITY`. For example:

```ts
const SECTION_RELATIONSHIP = ['## Your relationship with the owner', ...].join('\n');
const SECTION_VOICE = ['## Voice and style', ...].join('\n');
// ...
export function buildSystemPrompt(): string {
  return ['# Sym', '', IDENTITY, '', SECTION_RELATIONSHIP, '', SECTION_VOICE, ...].join('\n');
}
```

This makes the sections individually grep-able, diff-able, and testable. The assembled result is identical. Effort is medium because of the mechanical size, but the structure change is trivial.

---

### Z11-09 — `buildSystemPrompt` tests only verify existence, not content

**Evidence.**  
`packages/kernel/tests/prompt.test.ts:23–41`:

```ts
it('returns a non-empty string containing "Sym"', ...);
it('is stable across multiple calls (suitable for prompt-prefix caching)', ...);
it('does not include runtime/volatile data', ...);
```

No test verifies that required sections are present (e.g. `## How you work`, `## Your connectors`, `## Your boundaries`). A large edit that accidentally deletes a section would not be caught. No test verifies that `PRIVATE` and `SHARED` strings appear somewhere (relied on by `## Your boundaries`).

**Recommendation.**  
Add tests that assert the presence of each section heading and of the privacy keywords the system prompt relies on:

```ts
it('contains all required sections', () => {
  const prompt = buildSystemPrompt();
  for (const section of [
    '## Your relationship with the owner',
    '## Voice and style',
    '## How you work',
    '## Your connectors',
    '## Planning multi-step work',
    '## Reply discipline',
    '## Quality bar',
    '## Acting as your owner',
    '## Slack output',
    '## Presentation surfaces',
    '## Who you are talking to',
    '## Your boundaries',
    '## When you mess up',
  ]) {
    expect(prompt).toContain(section);
  }
});
```

---

### Z11-10 — `vitest.config.ts` test timeout is 4× too high

**Evidence.**  
`packages/kernel/vitest.config.ts:6–7`:

```ts
testTimeout: 20_000,
hookTimeout: 20_000,
```

The kernel's tests are pure string-manipulation unit tests with no I/O, no network, and no async work. `packages/adapter/slack` uses 10s and that package has normalization tests over more data. 20s here is a copy-paste default — it just bloats the failure-detection window.

**Recommendation.**  
Drop both timeouts to 5000ms:

```ts
testTimeout: 5_000,
hookTimeout: 5_000,
```

---

### Z11-11 — Package name "kernel" is vague

**Evidence.**  
The name `@sym/kernel` describes this package as the "kernel" of the system — implying it contains the core execution loop, scheduler, or agent loop. In reality, it contains three narrow utilities: prompt assembly, receipt building, and a tool-registry null-object wrapper. The actual agent loop is in `apps/agent/src/pi/loop.ts` (Pi SDK). The `packages/kernel/dist/loop.d.ts` stale artifact further reinforces the confusion — a newcomer would expect `loop.ts` to be the live entrypoint.

**Recommendation.**  
Consider renaming to `@sym/turn-primitives` or `@sym/agent-core` (matching what it actually contains: the building blocks for a turn). This is a medium effort due to `import` and `package.json` updates across `apps/agent` and its tests. Worth doing before OSS launch; a reader's first question will be "where is the kernel?" and the answer should match what they find.

---

### Z11-12 — `IDENTITY` constant extraction is undocumented

**Evidence.**  
`packages/kernel/src/prompt.ts:34–43`: `IDENTITY` is extracted into a module-level constant before `buildSystemPrompt`, but no comment explains why this extraction exists rather than inlining it into the function like all other sections. A contributor reading the file for the first time must infer the reason.

**Recommendation.**  
Add a one-line comment:

```ts
// Extracted so `buildSystemPrompt`'s structure matches its header comment:
// static section followed by per-section prose.
const IDENTITY = [...]
```

Or, if following the Z11-08 recommendation to extract all sections, remove the asymmetry entirely.

---

### Z11-13 — `ReceiptParams` re-exported as part of the public API but not useful to callers

**Evidence.**  
`packages/kernel/src/index.ts:4`:

```ts
export type { ReceiptParams } from './receipt.js';
```

`ReceiptParams` is the input shape for `buildReceipt`. No caller outside the package needs to name this type — they construct the argument inline at the call site in `apps/agent/src/pi/loop.ts:720`. Exporting it enlarges the public surface and implies it is a stable contract type when it is really an implementation detail of `receipt.ts`.

**Recommendation.**  
Remove from `index.ts`. If a future caller needs it, add it back with intent.

---

## Proposed chunks

### Chunk 1 — Clean dist and tighten public surface (foundation)

**Goal:** A clean, minimal public API with no orphaned artifacts.

- Delete stale `dist/soul.*`, `dist/tone.*`, `dist/loop.*`.
- Remove `buildTurnContextPrompt` and `ReceiptParams` from `index.ts`.
- Delete `ToolRegistry.hasTools()`.
- Drop dead spec reference in `prompt.ts:31`.
- Reduce vitest timeout to 5s.

Depends on: nothing. No cross-package impact (the removed exports are unused outside).

---

### Chunk 2 — Fix slash-command visibility label (correctness)

**Goal:** The model context accurately describes privacy for every entry surface.

- Broaden the private-visibility predicate in `buildTurnContextPrompt` to include `'slash_command'`.
- Add the missing test case.

Depends on: Chunk 1 (cleaner surface, but not technically blocking).

---

### Chunk 3 — Add missing tests for receipt.ts and tools.ts

**Goal:** Zero untested modules in packages/kernel.

- Add `tests/receipt.test.ts` (buildReceipt, optional field omission, toolsInvoked).
- Add `tests/tools.test.ts` (null dispatcher, delegation, hasTools removal if Chunk 1 is done).
- Extend `buildSystemPrompt` tests with section-presence assertions.

Depends on: Chunk 1.

---

### Chunk 4 — Move OwnerIdentity to @sym/contracts (type placement)

**Goal:** Domain types live in contracts; kernel imports them.

- Add `OwnerIdentity` to `packages/contracts/src/domain.ts`.
- Update `packages/kernel/src/prompt.ts` to import from `@sym/contracts`.
- Update all consumer imports in `apps/agent`.

Depends on: nothing (pure type move, no runtime change). Can run in parallel with Chunk 1.

---

### Chunk 5 — Extract prompt sections into named constants (maintainability)

**Goal:** Each section of `buildSystemPrompt` is independently grep-able and testable.

- Extract all 13 `##` sections to named `const` values in `prompt.ts`.
- Assert section presence in test.

Depends on: Chunk 3 (test pass ensures no regression from the structural refactor).
