# Zone Z04: Core agent — entry & orchestration

## Summary

The zone is in generally good shape for an OSS project. The request lifecycle is cleanly layered: env parsing (config.ts) → HTTP surface (server.ts) → owner gate (owner-gate.ts) → per-turn orchestration (handle-turn.ts) → Pi loop (cross-ref). Logging discipline is excellent — no `console.log` violations anywhere. Error handling is consistent and fail-open where appropriate. The two largest files (`handle-turn.ts` at 1 057 lines and `server.ts` at 804 lines) have grown organically to the point where individual functions are doing too much and a newcomer needs significant context to navigate them; both are ripe for extraction. The most impactful structural finding is that `TaskCardManager` — a 180-line class with its own lifecycle, parallelism model, and plan-mode latch — is buried inside `handle-turn.ts` alongside streaming logic, history loading, viewed-channel context, and the top-level `handleTurn` orchestrator; it deserves its own module. Minor issues include: three copy-pasted Slack-signature-verification blocks in server.ts; a `BehaviorConfig.taskCardAfter` field that is parsed, stored, and documented but never consumed; several env vars (`SYM_MCP_CONNECT_TIMEOUT_MS`, `SYM_CLI_CONFIRM`, `SYM_CLI_ALLOWLIST`, `SYM_CONFIG_PATH`, `SYM_PUBLIC_URL`) live outside `config.ts` and are absent from `.env.example`; a stale JSDoc ghost comment in handle-turn.ts; and stale planning-era references ("Phase B", "chunk-3") sprinkled through inline comments.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                                                              | Files                                                                                                         | Effort  |
| ------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- |
| Z04-01 | high     | structure   | `handle-turn.ts` bundles four unrelated concerns in one 1 057-line file                                                                                                            | `handle-turn.ts`                                                                                              | medium  |
| Z04-02 | high     | structure   | Three copy-pasted Slack signature verification blocks in server.ts                                                                                                                 | `server.ts:335–344`, `387–395`, `504–511`                                                                     | small   |
| Z04-03 | high     | structure   | `server.ts` inner-function soup — five nested functions inside `createServer`                                                                                                      | `server.ts:85–330`                                                                                            | medium  |
| Z04-04 | medium   | dead-code   | `BehaviorConfig.taskCardAfter` is parsed, configured, and documented but never read                                                                                                | `config.ts:25,82,104`, `handle-turn.ts`                                                                       | trivial |
| Z04-05 | medium   | config      | `SYM_MCP_CONNECT_TIMEOUT_MS`, `SYM_CLI_CONFIRM`, `SYM_CLI_ALLOWLIST`, `SYM_CONFIG_PATH`, `SYM_PUBLIC_URL` bypass `config.ts` and are absent from `.env.example`                    | `mcp/dispatcher.ts:54`, `pi/loop.ts:562`, `run-cli.ts:68`, `mcp/source.ts:44`, `mcp/providers/provider.ts:77` | small   |
| Z04-06 | medium   | type-safety | `replySink` callback carries `blocks: unknown[]` instead of `SlackBlock[]`                                                                                                         | `handle-turn.ts:89`                                                                                           | trivial |
| Z04-07 | medium   | security    | `response_url` values from Slack payloads are passed to `fetch` without validating the domain                                                                                      | `server.ts:477,571,745`                                                                                       | small   |
| Z04-08 | medium   | type-safety | `WorkspaceContext.mcpServers` is populated at boot but never consumed — stale field on the context object                                                                          | `workspace-context.ts:51,72`                                                                                  | trivial |
| Z04-09 | medium   | docs        | Stale planning-era references ("Phase B", "chunk-3") in inline comments                                                                                                            | `handle-turn.ts:50`, `plan-controller.ts:22`, `builtin-tools.ts:368`                                          | trivial |
| Z04-10 | low      | docs        | Ghost JSDoc block for `heroRenderParts` is detached — two consecutive `/** … */` blocks before `needsLlmCleanup`, leaving `heroRenderParts` undocumented                           | `handle-turn.ts:346–363`                                                                                      | trivial |
| Z04-11 | low      | naming      | `denyReason` / `DenyReason` are exported but used only internally in `owner-gate.ts`                                                                                               | `owner-gate.ts:19,21`                                                                                         | trivial |
| Z04-12 | low      | complexity  | `streamReply` is 310 lines with three interlocked delivery cases; inline comments are the only navigation aid                                                                      | `handle-turn.ts:567–877`                                                                                      | medium  |
| Z04-13 | low      | structure   | `normalizeSlackEvent` + `slackTurnInputToTurn` are called identically in two places (`processEvent` and `processSlashCommand`)                                                     | `server.ts:160–166`, `243–249`                                                                                | trivial |
| Z04-14 | low      | consistency | `createDedup` and `createAssistantContextStore` use identical bounded-LRU eviction logic; one helper would unify them                                                              | `server.ts:38–49`, `assistant-context.ts:45–54`                                                               | trivial |
| Z04-15 | low      | complexity  | `loadViewedChannelContext` is 50 lines with a three-branch resolver; it could live in its own module alongside `loadTurnHistory`                                                   | `handle-turn.ts:885–935`                                                                                      | small   |
| Z04-16 | low      | testing     | `streamReply`'s three delivery cases (buffer-mode, no-stream, live-stream) are tested only through `handleTurn` integration tests; no isolated unit tests for the cases themselves | `tests/handle-turn.test.ts`                                                                                   | small   |
| Z04-17 | low      | testing     | `server.ts`'s `processSlashCommand` response_url fallback path (seed fails, falls back to response_url) is not tested                                                              | `tests/server.test.ts`                                                                                        | medium  |

---

## Detail

### Z04-01 — `handle-turn.ts` bundles four unrelated concerns in one 1 057-line file

**Evidence.** A single file contains:

- `TaskCardManager` (lines 155–335) — a 180-line class with its own parallelism model, threshold buffer, and plan-mode latch.
- Streaming delivery (`streamReply`, lines 567–877) — 310 lines of multi-case delivery logic.
- Context loading (`loadTurnHistory`, `loadViewedChannelContext`) — 100 lines of Slack API reads.
- Top-level orchestration (`handleTurn`, lines 948–1057) — the public entry point.
- Small pure helpers (`capitalize`, `clipNotif`, `heroRenderParts`, `deriveTitle`, etc.) scattered throughout.

A newcomer wanting to understand, say, the streaming delivery cases must navigate past the TaskCardManager class, context-loading helpers, and pure utilities to find it.

**Recommendation.** Extract into four co-located modules:

- `task-card-manager.ts` — move `TaskCardManager` and `TrackedTask`; tests already import it from `handle-turn.ts` so the rename is a one-line fix.
- `turn-context.ts` — `loadTurnHistory`, `loadViewedChannelContext`, `loadViewedChannelContext`, `maybeSetThreadTitleFromTurn`.
- `stream-reply.ts` — `streamReply` and its local helpers (`flushBuffer`, `ensureStreamOpen`, etc.).
- `handle-turn.ts` — retains `handleTurn` (the entry point), `runTurnLoop`, `finalReplyBody`, `heroRenderParts`, and the small pure helpers.

`tests/task-card-manager.test.ts` already imports `TaskCardManager` from `handle-turn.ts`; updating the import path is the only required change to tests.

---

### Z04-02 — Three copy-pasted Slack signature verification blocks in server.ts

**Evidence.**

```
server.ts:335   const verification = verifySlackSignature({ signingSecret: ..., headers: { ... }, rawBody });
server.ts:387   const verification = verifySlackSignature({ signingSecret: ..., headers: { ... }, rawBody });
server.ts:504   const verification = verifySlackSignature({ signingSecret: ..., headers: { ... }, rawBody });
```

Three Hono route handlers (`/slack/events`, `/slack/interactivity`, `/slack/commands`) each copy the same 10-line block: `c.req.text()`, construct the same `headers` object, call `verifySlackSignature`, and return `c.json({ error: verification.reason }, 401)` on failure.

**Recommendation.** Extract a `verifySlack(c: Context, signingSecret: string): Promise<{ ok: true; rawBody: string } | Response>` helper. Each route calls it once and early-returns on the `Response` case. Reduces the verification surface to a single auditable path.

---

### Z04-03 — `server.ts` inner-function soup — five nested functions inside `createServer`

**Evidence.** `createServer` (lines 59–729) contains five functions defined in its closure:

- `ownerGate` (line 85)
- `logDeniedAttempt` (line 98)
- `processEvent` (line 122)
- `buildTurnDeps` (line 201)
- `processSlashCommand` (line 237)

These are closures over `ctx`, `config`, `assistantContext`, and `alreadySeen`. While this is a legitimate pattern for tight coupling, it makes `server.ts` 804 lines long and prevents the inner functions from being individually tested. `processEvent` and `processSlashCommand` are 100+ lines each and contain substantial business logic.

**Recommendation.** Extract `processEvent` and `processSlashCommand` to a dedicated `event-router.ts` file. They can receive `ctx`, `config`, `ownerGate`, `assistantContext`, and `buildTurnDeps` as parameters instead of closing over them, making them independently testable. `buildTurnDeps` and `logDeniedAttempt` should remain in `server.ts` as they are tightly coupled to the config/ctx objects.

---

### Z04-04 — `BehaviorConfig.taskCardAfter` is parsed, configured, and documented but never read

**Evidence.**

- `config.ts:25`: `taskCardAfter: 'delete' | 'collapse'` — field declared on `BehaviorConfig`.
- `config.ts:82–85`: `taskCardAfter()` parsing function.
- `config.ts:104`: `taskCardAfter: taskCardAfter(process.env['TASK_CARD_AFTER'])` — assigned in `loadAgentConfig`.
- `.env.example`: documents the `TASK_CARD_AFTER` env var with two options.
- `handle-turn.ts`: `deps.behavior.taskCardAfter` is **never read**. Only `taskCardThreshold` and `ownerPostMarker` are consumed (`handle-turn.ts:702,996`).
- Tests pass `taskCardAfter: 'delete'` in every fixture but only to satisfy the type — no test exercises the `'collapse'` branch.

The feature was designed but the implementation was never wired up. The card is always deleted without inspecting this setting.

**Recommendation.** Either implement the `'collapse'` behaviour in `streamReply` (the `finish()` call after the model loop ends would check `deps.behavior.taskCardAfter` and conditionally call `chatUpdate` to replace the card with a summary line), or remove the dead field, the parser function, the env var documentation, and the fixture stub.

---

### Z04-05 — Several env vars bypass `config.ts` and are absent from `.env.example`

**Evidence.** The following env vars are read directly via `process.env` outside `config.ts` and do not appear in `.env.example`:

| Env var                      | Read at                        |
| ---------------------------- | ------------------------------ |
| `SYM_MCP_CONNECT_TIMEOUT_MS` | `mcp/dispatcher.ts:54`         |
| `SYM_CLI_CONFIRM`            | `pi/loop.ts:562`               |
| `SYM_CLI_ALLOWLIST`          | `run-cli.ts:68`                |
| `SYM_CONFIG_PATH`            | `mcp/source.ts:44`             |
| `SYM_PUBLIC_URL`             | `mcp/providers/provider.ts:77` |

A newcomer reading `config.ts` and `.env.example` (the canonical config surface) cannot discover these. An operator who misconfigures any of them gets no error until deep runtime behaviour fails.

**Recommendation.** Add each of these vars to `AgentConfig`, parse them in `loadAgentConfig()`, and thread them through to the modules that use them. At minimum, add them (commented out, with explanation) to `.env.example` so they are discoverable.

---

### Z04-06 — `replySink` callback carries `blocks: unknown[]` instead of `SlackBlock[]`

**Evidence.**

```typescript
// handle-turn.ts:87-98
replySink?: (msg: {
  text: string;
  blocks: unknown[];   // <-- should be SlackBlock[]
  receiptText: string;
}) => Promise<void>;
```

The blocks assembled at `handle-turn.ts:1032` are `SlackBlock[]` (from `markdownBlocks`, `renderBlocks`, and `receiptToContextBlock`). Widening to `unknown[]` at the callback boundary discards the type and forces the caller (in `server.ts`) to pass them onward equally untyped.

**Recommendation.** Replace `unknown[]` with `SlackBlock[]` (exported from `@sym/adapter-slack`). The server.ts call site constructs `headedBlocks` by spreading with a plain object literal `{ type: 'markdown', text: attribution }` — that literal should be typed as `SlackBlock` too.

---

### Z04-07 — `response_url` values from Slack payloads are passed to `fetch` without domain validation

**Evidence.**

- `server.ts:531`: `const responseUrl = params.get('response_url') ?? ''` — read from a form-encoded Slack slash-command body.
- `server.ts:435`: `const responseUrl = payload.response_url` — read from a JSON block-actions payload.
- `server.ts:477`, `server.ts:571`, `server.ts:745`: All three are forwarded verbatim to `fetch(responseUrl, …)` or `postToResponseUrl(responseUrl, …)`.

In practice Slack always delivers `https://hooks.slack.com/…` URLs, but the agent trusts the value without verifying the domain. A hypothetical SSRF would allow a crafted interactivity payload (from a team bypass or a future bug in the workspace guard) to exfiltrate the reply text to an arbitrary URL. The risk is mitigated by the Slack signature verification and the workspace/owner gates that precede the call, but the lack of URL validation is a defense-in-depth gap.

**Recommendation.** In `postToResponseUrl`, validate that the URL starts with `https://hooks.slack.com/` before making the request. Reject with a `console.warn` and return `false` (the existing failure path) if it does not. One-line guard, single auditable location.

---

### Z04-08 — `WorkspaceContext.mcpServers` is populated at boot but never consumed

**Evidence.**

- `workspace-context.ts:51`: `mcpServers: ConnectorConfig[]` declared on `WorkspaceContext`.
- `workspace-context.ts:72`: `mcpServers: config.mcpServers` populated in `loadWorkspaceContext`.
- `server.ts:217` (comment): "No mcpConfigs here: handleTurn reads the LIVE active set (getActiveConfigs), which POST /admin/reload reconciles out-of-band. Passing the boot-frozen ctx.mcpServers would pin every turn to the startup config and defeat reload."
- Nowhere in `server.ts` is `ctx.mcpServers` accessed.

The comment in `buildTurnDeps` explains exactly why it is not used, but the field is still carried on the context type and populated every boot.

**Recommendation.** Remove `mcpServers` from the `WorkspaceContext` interface and from `loadWorkspaceContext`. The comment in `buildTurnDeps` should remain (it explains why `handleTurn` reads `getActiveConfigs()` directly) but does not need a corresponding dead field.

---

### Z04-09 — Stale planning-era references in inline comments

**Evidence.**

- `handle-turn.ts:50`: `"as-owner writes (Phase B)."` — refers to a planning label from before open-source cleanup.
- `plan-controller.ts:22`: `"See the chunk-3 persistence discussion for the path to surviving them."` — refers to an internal planning document.
- `builtin-tools.ts:368`: `"// Phase B — Act-as-owner write tools (user-token only)"` — same planning label.

These references are meaningless to a newcomer and make the code look unfinished.

**Recommendation.** Replace each with a plain-English description of what the deferred work actually is. For example, `plan-controller.ts:22`: change "See the chunk-3 persistence discussion" → "Plan rows are not yet persisted across restarts; the reply text is the only durable record." For `handle-turn.ts:50` and `builtin-tools.ts:368`: drop the "Phase B" label and describe the capability directly.

---

### Z04-10 — Ghost JSDoc block for `heroRenderParts` is detached

**Evidence.**

```typescript
// handle-turn.ts:346-397
/**
 * The turn's single "hero" render. A turn may collect multiple render intents
 * (e.g. two searches); we surface only the LAST one...
 */
/**
 * Whether to run the LLM cleanup backstop...
 */
function needsLlmCleanup(reply: Reply, planController: PlanController): boolean { … }

// …then immediately:
function heroRenderParts(reply: Reply): { … } { … }
```

The JSDoc at line 346 was written for `heroRenderParts` but a subsequent edit inserted `needsLlmCleanup` between the comment and its function. The comment now documents `needsLlmCleanup` (which has its own JSDoc), and `heroRenderParts` is left without one.

**Recommendation.** Move the `heroRenderParts` JSDoc directly above `heroRenderParts`. Remove the duplicate first comment from above `needsLlmCleanup` (the second one is the correct one).

---

### Z04-11 — `denyReason` / `DenyReason` are exported but used only inside `owner-gate.ts`

**Evidence.**

```typescript
// owner-gate.ts:19-22
export type DenyReason = 'not_owner' | 'owner_unset';
export function denyReason(ownerSlackUserId: SlackUserId | null): DenyReason { … }
```

Both are exported. The only caller outside the file is `tests/owner-gate.test.ts` (test coverage), not production code. In production, `denyReason` is called only at line 52 inside `formatDeniedAttempt`.

**Recommendation.** Remove the `export` keywords from `DenyReason` and `denyReason`. Import them in the test file from the same module with the internal name — or keep them exported if you want the test coverage on the helper directly (reasonable). The key point is that they are not part of the module's intentional public API; the JSDoc should clarify they are internal helpers.

---

### Z04-12 — `streamReply` is 310 lines with three interlocked delivery cases

**Evidence.** `streamReply` at `handle-turn.ts:567–877` handles:

1. **Buffer mode** (tool fires before any text): clean-then-append-then-close (lines 805–824).
2. **No stream opened** (empty/tool-only turn): `postFinal` (lines 828–831).
3. **Live stream with open stream**: flush tail, close, optionally settle (lines 836–858).

These three cases share a 200-line setup block (keepalive timer, `sendStatus`, `ensureStreamOpen`, `taskCard`, `onDelta`, `onToolStart`, `onToolEnd`, `flushBuffer`) before branching. A reader must hold all of it in memory to understand any one case.

**Recommendation.** As part of the Z04-01 extraction, split `streamReply` into:

- A setup function that returns the callbacks + helpers.
- Deliver helpers: `deliverBuffered`, `deliverNoStream`, `deliverLive` — each one is 15–20 lines and tests a clear precondition.
- `streamReply` becomes the coordinator: set up, run the loop, settle the card, call the right deliver helper.

---

### Z04-13 — `normalizeSlackEvent` + `slackTurnInputToTurn` called identically in two places

**Evidence.**

```typescript
// server.ts:160-166 (processEvent)
const input = normalizeSlackEvent({
  event: raw,
  workspaceId: ctx.workspaceId,
  botUserId: ctx.botUserId,
});
if (!input) return;
const turn = slackTurnInputToTurn(input);

// server.ts:243-249 (processSlashCommand)
const input = normalizeSlackEvent({
  event: rawEvent,
  workspaceId: ctx.workspaceId,
  botUserId: ctx.botUserId,
});
if (!input) return;
const turn = slackTurnInputToTurn(input);
```

Identical pattern, copy-pasted. If `normalizeSlackEvent`'s shape changes, both callers must be updated.

**Recommendation.** Extract a `rawEventToTurn(raw, ctx)` helper that encapsulates the two-step pipeline and returns `Turn | null`. Three lines saved per caller, one point of change.

---

### Z04-14 — `createDedup` and `createAssistantContextStore` share identical bounded-LRU eviction logic

**Evidence.**

```typescript
// server.ts:38-49 (createDedup)
if (seen.size > max) {
  for (const old of [...seen].slice(0, max / 2)) seen.delete(old);
}

// assistant-context.ts:45-54 (createAssistantContextStore)
if (store.size > max) {
  const half = Math.floor(max / 2);
  let i = 0;
  for (const k of store.keys()) {
    if (i >= half) break;
    store.delete(k);
    i++;
  }
}
```

Two independent implementations of the same "drop oldest half when over capacity" pattern. The `createDedup` version spreads the Set into an array (O(n) allocation); the store version iterates (O(n/2) but allocation-free).

**Recommendation.** Extract a `boundedEvict(map: Map<unknown, unknown> | Set<unknown>, max: number): void` helper (or inline it via a shared utility function). Low priority — this is a nice-to-have polish, not a bug.

---

### Z04-15 — `loadViewedChannelContext` is 50 lines with a three-branch resolver

**Evidence.** `handle-turn.ts:885–935` implements viewed-channel context loading with three distinct branch: user-id format, DM-id format, and channel-id format. Each branch calls a different `nameResolver` method and assembles a different label string. The function is pure enough to extract but is currently buried in the middle of `handle-turn.ts`.

**Recommendation.** As part of the Z04-01 extraction into `turn-context.ts`, this function moves naturally alongside `loadTurnHistory`. No logic change needed.

---

### Z04-16 — `streamReply`'s delivery cases are tested only through `handleTurn` integration tests

**Evidence.** `tests/handle-turn.test.ts` does cover CASE 1 (buffer mode, `handle-turn.test.ts:963`), CASE 2 (no stream, `handle-turn.test.ts:1047`), and CASE 3 (live + cleanup, `handle-turn.test.ts:888`) but only through the public `handleTurn` API with a heavily mocked Pi loop. The logic that selects among the cases (the `bufferMode`/`streamTs`/`liveBodyFlushed` flags) is not directly tested in isolation. Extracting `streamReply` per Z04-01 would make it directly importable in tests.

**Recommendation.** After Z04-01 extraction, add unit tests for each of the three delivery cases directly on the extracted `streamReply` function with a stub `runTurnLoop`.

---

### Z04-17 — `processSlashCommand` response_url fallback path is not tested

**Evidence.** `server.ts:237–331` implements a two-step path:

1. Try to post a seed message (`chatPostMessage`).
2. If that fails, fall back to `handleTurn` with a `replySink` that posts via `response_url`.

`tests/server.test.ts` covers the happy path (ACK + background kick, line 213) and the empty-text usage hint (line 193) but has no test where `chatPostMessage` rejects and the code falls through to the `response_url` path.

**Recommendation.** Add a server test: mock `chatPostMessage` to reject, then verify `handleTurn` is called with a `replySink`, and that `postToResponseUrl` fires with the assembled `attribution + answer` body.

---

## Proposed chunks

### Chunk 1: Remove `taskCardAfter` dead config (Z04-04)

**Goal:** Delete the dead `taskCardAfter` field from `BehaviorConfig`, its parser, the env-var assignment in `loadAgentConfig`, the fixture stubs in tests, and the `.env.example` documentation. OR implement the feature end-to-end if the collapse behavior is desired.

**Depends on:** nothing.

---

### Chunk 2: Fix `WorkspaceContext.mcpServers` dead field (Z04-08)

**Goal:** Remove `mcpServers` from `WorkspaceContext` and `loadWorkspaceContext`. The existing comment in `buildTurnDeps` stays as documentation for why `handleTurn` reads `getActiveConfigs()` directly.

**Depends on:** nothing.

---

### Chunk 3: Polish — ghost JSDoc, stale phase labels, dead exports, naming (Z04-09, Z04-10, Z04-11)

**Goal:** Fix the detached `heroRenderParts` JSDoc; replace "Phase B" / "chunk-3" internal labels with plain English; drop `export` from `denyReason`/`DenyReason`.

**Depends on:** nothing.

---

### Chunk 4: Centralize remaining env vars in `config.ts` + `.env.example` (Z04-05)

**Goal:** Move `SYM_MCP_CONNECT_TIMEOUT_MS`, `SYM_CLI_CONFIRM`, `SYM_CLI_ALLOWLIST`, `SYM_CONFIG_PATH`, `SYM_PUBLIC_URL` into `AgentConfig`; parse them in `loadAgentConfig()`; thread the values to callers. Add all five to `.env.example` as commented-out knobs with descriptions.

**Depends on:** nothing (pure config wiring, no behaviour change).

---

### Chunk 5: Add `response_url` domain validation (Z04-07)

**Goal:** In `postToResponseUrl`, reject URLs that do not start with `https://hooks.slack.com/`. Return `false` and log a warning. Adds a test.

**Depends on:** nothing.

---

### Chunk 6: Fix `replySink` blocks type (Z04-06)

**Goal:** Change `blocks: unknown[]` to `blocks: SlackBlock[]` in `HandleTurnDeps.replySink`. Fix the `headedBlocks` construction in `server.ts:301` to produce a typed `SlackBlock`.

**Depends on:** nothing (type-only change, verified by `tsc`).

---

### Chunk 7: Extract `verifySlack` middleware in server.ts (Z04-02)

**Goal:** Replace the three copy-pasted signature-verification blocks in `/slack/events`, `/slack/interactivity`, `/slack/commands` with a single `verifySlack(c, signingSecret)` helper function. Add a test that exercises the helper path in isolation.

**Depends on:** nothing.

---

### Chunk 8: Extract `normalizeSlackEvent` → `Turn` helper + eviction de-dup (Z04-13, Z04-14)

**Goal:** Add a `rawEventToTurn(raw, ctx)` helper that consolidates the two-call `normalizeSlackEvent + slackTurnInputToTurn` pipeline. Optionally, unify `createDedup` and `createAssistantContextStore` eviction into a shared helper.

**Depends on:** nothing.

---

### Chunk 9: Extract `TaskCardManager` to its own module (Z04-01 partial)

**Goal:** Move `TaskCardManager`, `TrackedTask`, and `TaskCardManager`'s helpers to `task-card-manager.ts`. Update `tests/task-card-manager.test.ts` import. This is the largest single-module gain from Z04-01 and unblocks independent testing.

**Depends on:** nothing; this is purely a file split with an import-path update.

---

### Chunk 10: Extract turn-context helpers (Z04-01 partial, Z04-15)

**Goal:** Move `loadTurnHistory`, `loadViewedChannelContext`, `maybeSetThreadTitleFromTurn`, and `deriveTitle` to `turn-context.ts`. These have no shared state and can be tested independently.

**Depends on:** Chunk 9 (handle-turn.ts is smaller, easier to reason about).

---

### Chunk 11: Extract `streamReply` to its own module (Z04-01 partial, Z04-12, Z04-16)

**Goal:** Move `streamReply` to `stream-reply.ts`. Split the three delivery cases into named helpers (`deliverBuffered`, `deliverNoStream`, `deliverLive`). Add direct unit tests for each delivery case (Z04-16).

**Depends on:** Chunk 9 (needs `TaskCardManager`), Chunk 10 (cleaner `handle-turn.ts`).

---

### Chunk 12: Add missing server test for `response_url` fallback path (Z04-17)

**Goal:** Add a `server.test.ts` case where the slash-command seed `chatPostMessage` rejects, verifying that `handleTurn` is called with a `replySink` and that `postToResponseUrl` fires with the right attribution + body.

**Depends on:** nothing; pure test addition.
