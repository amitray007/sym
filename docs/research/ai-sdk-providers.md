# AI SDK Provider Migration Research

**Question:** Should Sym migrate its model/agent layer from Pi (`@earendil-works/pi-agent-core` + `pi-ai`) to the Vercel AI SDK (`ai` + `@ai-sdk/fireworks`)?

**Verdict: Stay on Pi for now. The AI SDK's `needsApproval` model is architecturally incompatible with Sym's `beforeToolCall` gate. The reasoning_effort mapping is unclear. The multi-provider benefit is real but not currently needed.**

---

## 1. What Sym actually needs (enumerated from code)

| # | Requirement | File |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| R1 | Streaming text deltas fed to `onDelta` in real time | `loop-callbacks.ts:makeSubscriber` |
| R2 | Multi-step tool-call loop (model → tools → model → …) | `loop.ts:agent.prompt()` |
| R3 | Per-tool `onToolStart(toolCallId, label)` + `onToolEnd(toolCallId, errored)` events, with a stable `toolCallId` that matches start↔end | `loop-callbacks.ts:makeSubscriber` |
| R4 | **`beforeToolCall` gate: synchronous blocking hook** that runs an async function before each tool executes and can `{ block: true }` mid-loop, without ending the stream | `loop.ts:Agent({ beforeToolCall })`, `loop-callbacks.ts:makeBeforeToolCall` |
| R5 | Forced `reasoning_effort` ≥ low for gpt-oss-120b on Fireworks (`'off'` → 400 from Fireworks) | `loop.ts` comment + `think-router.ts` |
| R6 | `thinkingLevel: 'low'                                                                                                                                                    | 'medium'                                                                                   | 'high'` mapped to Fireworks reasoning_effort | `think-router.ts`, `loop.ts:Agent({initialState:{thinkingLevel}})` |
| R7 | AbortSignal cancellation (via `agent.abort()` today; a proper signal on prompt is noted as future Pi work) | `loop.ts:agent.abort()` |
| R8 | Per-turn token usage extraction (input + output + total) for receipt + OTel span | `agent-messages.ts:extractUsage` |
| R9 | Thinking deltas filtered out — reasoning text MUST NOT reach `onDelta` or Slack | `loop-callbacks.ts` comment; the Harmony demux on the anthropic-messages surface does this |
| R10 | Plain single-step LLM call for `cleanupReply` and `judgeSlackToolUse` (no tools, just text out) | `reply-cleanup.ts`, `slack-guard.ts` |
| R11 | `Anthropic-Messages` API surface (not OpenAI completions) so Fireworks's Harmony channels demux `thinking_delta` cleanly | `model.ts:buildFireworksModel` comment |

---

## 2. AI SDK capability matrix

### R1 — Streaming text deltas

**Supported natively.**

`streamText` exposes `fullStream` as an `AsyncIterable<TextStreamPart>`. The `text-delta` event type carries the delta string. Equivalent to Pi's `text_delta`. Can drive `onDelta` directly from the stream consumer.

### R2 — Multi-step tool loop

**Supported natively.**

`streamText` has a `maxSteps` parameter (default safety cap 20, configurable) that drives the loop automatically. Each step is an LLM call; tool results feed back automatically. `stopWhen: stepCountIs(N)` or custom `StopCondition` provides further control.

### R3 — Per-tool start/end with stable toolCallId

**Supported with adaptation.**

`streamText` emits `tool-call-streaming-start` and `tool-result` parts on `fullStream`, both carrying `toolCallId`. The `experimental_onToolCallStart` and `experimental_onToolCallFinish` callbacks provide the same data with `success` and `error` fields on finish. These are `experimental_` prefixed (unstable API surface). The `toolCallId` is stable across start and end — the card-pairing logic would work.

Gap: The callbacks are `experimental_` — they may change without semver. The current Pi events (`tool_execution_start` / `tool_execution_end`) are stable.

### R4 — `beforeToolCall` gate (THE CRITICAL GAP)

**NOT supported in the required form.**

Pi's `beforeToolCall` is a **synchronous blocking hook inside the running loop**. It receives the tool name + args, can call async operations (Slack confirmation prompt, LLM relevance judge), and returns `{ block: true }` or `undefined` — all before the tool runs, without ending or restarting the stream. The loop pauses for the hook and continues.

The AI SDK's `needsApproval` is a **two-pass mechanism, not a blocking hook:**

- First `streamText`/`generateText` call returns with `tool-approval-request` parts in `result.content`. Execution halts — the stream is done.
- Your code then runs the confirmation UI.
- A **second** `streamText`/`generateText` call is made with `tool-approval-response` injected into messages.

This is architecturally different. Mapping Sym's gate to this model requires:

1. Breaking the single `runLoopPi` call into a state machine with multiple `streamText` calls.
2. Re-implementing the conversation history threading between calls (Sym uses its own `ChatMessage[]` shape).
3. Handling partial streaming (text already emitted before the tool fires) across the restart boundary.
4. Two LLM round-trips per confirmed tool call instead of one uninterrupted stream.

The Slack-read guard (`judgeSlackToolUse`) makes a fast LLM call and caches the verdict per turn. Under the two-pass model, this call still happens, but it now falls outside both `streamText` invocations — it must be orchestrated by the caller. The guard state (per-turn `slackGuardVerdict` cache) becomes caller-owned state across multiple `streamText` calls.

**This is the decision-driver.** Sym's `beforeToolCall` gate is one of the most load-bearing design features of the agent — it backs privacy protection, destructive-tool confirmation, and Slack-scope guards. Adapting it to the two-pass model is a significant architecture change, not a mechanical port.

### R5 — Forced reasoning_effort ≥ low for gpt-oss-120b

**Unclear — likely supported with adaptation, but undocumented for gpt-oss-120b.**

The AI SDK Fireworks provider supports `providerOptions` for reasoning: `thinking: { type: 'enabled', budgetTokens: N }` for Kimi K2.5 and DeepSeek-R1 models. The documentation says nothing about gpt-oss-120b specifically (it does not appear in the provider's documented model list at all).

Pi's `pi-ai` registry has a first-class entry for `accounts/fireworks/models/gpt-oss-120b` with `api: 'anthropic-messages'` and it knows that `thinkingLevel: 'off'` maps to `reasoning_effort: 'none'` which Fireworks rejects. This institutional knowledge is baked into `model.ts`.

Under the AI SDK, passing `providerOptions: { fireworks: { reasoning_effort: 'low' } }` is plausible (that's how OpenAI-compat reasoning_effort is typically threaded through provider options), but:

- The AI SDK Fireworks provider docs don't document `reasoning_effort` as a supported option.
- There is no documented mapping for gpt-oss-120b at all.
- If the AI SDK Fireworks provider uses the OpenAI-compat surface (not Anthropic-messages), the Harmony demux that separates `thinking_delta` from `text_delta` may not apply — meaning R9 (filter reasoning from output) is at risk.

This would require empirical testing. Pi's `buildFireworksModel` and the Harmony demux are handling a non-trivial protocol concern that the AI SDK Fireworks provider has not documented addressing.

### R6 — ThinkingLevel (low / medium / high) mapping

**Supported with adaptation.**

The AI SDK has no concept of `thinkingLevel` as a named level. The equivalent is `providerOptions: { fireworks: { thinking: { type: 'enabled', budgetTokens: N } } }`. The `pick ThinkingLevel` → budget-tokens mapping would need to be defined by Sym (e.g. low=2000, medium=8000, high=16000). Not hard, but it's custom work.

### R7 — AbortSignal cancellation

**Supported natively.**

`streamText` accepts `abortSignal: AbortSignal` directly — it's a first-class parameter, not a workaround like Pi's `agent.abort()` + event listener dance. This is actually a genuine improvement over Pi.

### R8 — Per-turn token usage

**Supported natively.**

`onStepFinish` receives a `usage` object with input/output tokens per step. `onFinish` provides the aggregate. Equivalent to `extractUsage(newMessages)`.

### R9 — Thinking/reasoning deltas filtered from output

**Unclear — high risk.**

Pi's `anthropic-messages` surface (Harmony) demuxes `thinking_delta` events cleanly: they arrive as a separate event type that Pi's subscriber ignores. The `text_delta` stream is clean.

The AI SDK Fireworks provider does NOT document using the Anthropic-messages surface for gpt-oss-120b. The AI SDK `fullStream` has a `reasoning` part type, but whether Fireworks's gpt-oss-120b reasoning shows up as `reasoning` parts or leaks into `text-delta` depends on which protocol surface the AI SDK Fireworks provider uses. If it uses OpenAI-completions, `<parameter name="think">` tags may appear inline in text deltas — they would then reach `onDelta` and appear in the Slack message body. This is the exact failure mode described in `model.ts`:

> "Calling it via openai-completions leaks reasoning text and phantom tool-call frames into delta.content."

### R10 — Plain single-step LLM call (cleanup, guard)

**Supported natively, simpler.**

`generateText` (non-streaming) with no tools is the direct equivalent of Pi's no-tool `Agent.prompt()` pattern used in `cleanupReply` and `judgeSlackToolUse`. This would simplify those two callsites.

### R11 — Anthropic-Messages API surface for Harmony demux

**Not addressed by the AI SDK Fireworks provider.**

The AI SDK Fireworks provider appears to use the OpenAI-completions-compatible surface (that's what Fireworks's `/inference/v1` exposes publicly). Pi's Harmony layer specifically targets the `anthropic-messages` surface at Fireworks for gpt-oss-120b. There is no indication the AI SDK Fireworks provider offers this; it is not documented. This is the same risk as R9 — the demux that makes Sym's streaming clean is Pi-specific.

---

## 3. Migration effort (file-by-file)

| File                   | Change needed                                                                                                                                 | Effort |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `pi/loop.ts`           | Full rewrite: `Agent` → `streamText`, state machine for multi-pass `needsApproval` loops                                                      | XL     |
| `pi/loop-callbacks.ts` | Full rewrite: `makeBeforeToolCall` disappears (no Pi-style hook); confirmation logic moves to caller orchestration between `streamText` calls | XL     |
| `pi/model.ts`          | Replace `buildFireworksModel` with `createFireworks({ apiKey, baseURL })`                                                                     | S      |
| `pi/agent-messages.ts` | Replace `toAgentMessages` with AI SDK `CoreMessage[]` conversion; `extractUsage` → `onStepFinish` aggregation                                 | M      |
| `pi/agent-setup.ts`    | Replace `bridgeTools` + `AgentTool[]` with `tool()` definitions in AI SDK format                                                              | M      |
| `pi/think-router.ts`   | Map `ThinkingLevel` → `budgetTokens` for `providerOptions`; no structural change                                                              | S      |
| `run-turn-loop.ts`     | Update to call new loop; wire AbortSignal (actually simpler)                                                                                  | S      |
| `reply-cleanup.ts`     | Replace Pi `Agent` with `generateText`; simpler                                                                                               | S      |
| `slack-guard.ts`       | Replace Pi `Agent` with `generateText`; simpler                                                                                               | S      |

Total: the loop + callbacks rewrite is the dominant cost, driven entirely by the `beforeToolCall` → two-pass gap.

---

## 4. Multi-provider story (the main motivation)

The multi-provider pitch is real: with the AI SDK provider registry, switching from Fireworks to Anthropic or OpenAI is:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
const model = anthropic('claude-opus-4-5');
```

vs. today's Pi, which requires a new `pi-ai` registry entry for each provider (Pi's `getModel('fireworks', ...)` is a typed lookup — adding Anthropic means a new Pi-side integration).

**But Sym doesn't have a concrete multi-provider requirement today.** The user's main motivation is "making adding more providers easy." That's a future-proofing goal — not blocked by a current bug or feature request. The multi-provider benefit does not justify the `beforeToolCall` architectural surgery at this point.

If a concrete second provider were needed (e.g. "add Anthropic claude-opus-4-5 as the cleanup model"), it could be added to Pi straightforwardly — Pi supports Anthropic natively (`@earendil-works/pi-ai` has `anthropic` as a first-class provider).

---

## 5. Gaps summary

| Gap                                                                           | Severity     | Notes                                                            |
| ----------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------- |
| `beforeToolCall` is two-pass in AI SDK, not a blocking hook                   | **CRITICAL** | Architecture change, not a port                                  |
| gpt-oss-120b not documented in AI SDK Fireworks provider                      | **HIGH**     | May work via OpenAI-compat surface but Harmony demux won't apply |
| Thinking/reasoning leaking into text-delta (R9) if OpenAI-compat surface used | **HIGH**     | Would surface raw `<think>` tags in Slack replies                |
| `experimental_onToolCallStart/Finish` callbacks are unstable API              | MEDIUM       | May change without semver                                        |
| reasoning_effort not documented for gpt-oss-120b                              | MEDIUM       | Empirical testing required                                       |
| `thinkingLevel` → `budgetTokens` mapping is custom work                       | LOW          | Trivial to implement                                             |

---

## 6. Verdict

**Stay on Pi. Migrate later, with a concrete trigger.**

Reasons:

1. **The `beforeToolCall` gate cannot be ported without an architectural change.** The AI SDK's two-pass `needsApproval` model requires breaking the single streaming turn into a state machine with multiple LLM round-trips and caller-owned guard state. This is a significant rewrite of Sym's most load-bearing safety feature. It's not dangerous to do eventually — but it's not a mechanical port.

2. **The gpt-oss-120b + Harmony demux is unproven on the AI SDK Fireworks provider.** Pi's use of the `anthropic-messages` surface is the reason Sym's streaming is clean (no reasoning text in replies). The AI SDK Fireworks provider uses the OpenAI-compat surface. Until this is validated empirically, migrating risks `<think>` tags appearing in Slack messages.

3. **Multi-provider is not blocked by Pi.** Pi supports Anthropic natively. Adding a second provider (e.g. for the cleanup/guard calls) is feasible within Pi today. The AI SDK makes this _easier_ but Sym doesn't have a queued multi-provider task.

**What would trigger migration:**

- A concrete second-provider requirement (e.g. "route reasoning turns to Claude, routing turns to Fireworks") that Pi can't handle cleanly.
- Pi going unmaintained / breaking on a Node.js upgrade (Pi currently requires `>=22.19.0`).
- The AI SDK Fireworks provider documenting and validating gpt-oss-120b on the Anthropic-messages surface with clean reasoning demux.
- Sym's `beforeToolCall` gate being refactored into a middleware layer anyway (e.g. for the MCP creds/OAuth work), making the two-pass pattern a natural fit.

**What's worth taking from the AI SDK research even if staying on Pi:**

- `abortSignal` passed directly to `prompt()` — once Pi exposes this (noted as future work in `loop.ts`), update the abort wiring.
- The `generateText` pattern for `cleanupReply` and `judgeSlackToolUse` is genuinely cleaner than the Pi `Agent` pattern for no-tool single-call uses. If Pi ever introduces instability in those paths, swapping just those two to the AI SDK is low-risk.
