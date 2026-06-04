# Slack Adapter Replacement Assessment

**Question:** Can Sym replace `packages/adapter/slack` with the chat-sdk official Slack adapter
(`@chat-adapter/slack`, from chat-sdk.dev / vercel/chat) and/or `@slack/web-api` + `@slack/bolt`?

**Verdict: Stay custom for streaming + assistant-threads. Partial adoption of `@slack/web-api` types is viable but not worth it.**

---

## 1. What Sym's Adapter Actually Does

`packages/adapter/slack/src/` covers:

| Area               | Files                           | Detail                                                                                                                                           |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web API transport  | `web-api-client.ts`, `retry.ts` | Custom `fetch`-based client; JSON + form-urlencoded dispatch; 429 retry with exponential backoff                                                 |
| Streaming API      | `web-api-client.ts`             | `chat.startStream`, `chat.appendStream`, `chat.stopStream`; `task_update` chunks; `taskDisplayMode: 'plan'`; chunk interleaving fix              |
| Assistant threads  | `web-api-client.ts`             | `assistant.threads.setStatus` (with `loading_messages`), `setSuggestedPrompts`, `setTitle`                                                       |
| Standard messaging | `web-api-client.ts`             | `chat.postMessage`, `chat.update`, `chat.delete`, `reactions.add`                                                                                |
| Read APIs          | `web-api-client.ts`             | `conversations.replies/history/info/list` (paginated), `users.info/list` (paginated), `search.messages`, `auth.test`                             |
| User-token ops     | `web-api-client.ts`             | `users.profile.set`, `reminders.add` (xoxp act-as-owner path)                                                                                    |
| HMAC verify        | `verify.ts`                     | `verifySlackSignature` — HMAC-SHA256 with timing-safe compare, 5-min replay window                                                               |
| Block Kit          | `blocks.ts`, `render.ts`        | `markdown`, `table`, `header`, `section`, `context`, `actions` builders; `markdownBlocks` chunker; `renderIntentToBlocks` (table + card intents) |
| Normalization      | `normalize.ts`                  | Raw Slack webhook → `SlackTurnInput` → `Turn`; covers app_mention, dm, mpim, shortcut, slash_command, assistant lifecycle                        |
| Thread history     | `thread.ts`                     | `threadToHistory` — Slack thread messages → `ChatMessage[]` for the kernel                                                                       |
| Response-receipt   | `receipt.ts`                    | `receiptToContextBlock` — token/duration/tools footer as a Slack context block                                                                   |
| ID utilities       | `ids.ts`                        | `isSlackUserId`, `isSlackChannelId`, `isSlackDmId`                                                                                               |

The streaming pipeline in `apps/agent/src/stream-reply.ts` calls:

- `assistantThreadsSetStatus` (shimmer keepalive at 90s intervals)
- `chatStartStream` with `taskDisplayMode: 'plan'`
- `chatAppendStream` with both `markdown_text` and `task_update` chunks
- `chatStopStream` with Block Kit receipt blocks
- `chatUpdate` (cleanup/settle after close)

The task-card manager in `task-card-manager.ts` sends `TaskUpdateChunk` objects with full
`pending / in_progress / complete / error` state transitions, including parallel tool tracking
keyed by `toolCallId`.

---

## 2. Candidate SDKs

### 2a. `@chat-adapter/slack` (chat-sdk.dev / vercel/chat)

chat-sdk.dev is a Vercel-maintained unified chat-bot SDK. The Slack adapter wraps `@slack/web-api`'s
`WebClient` (exposed as `.webClient`) and adds lifecycle handlers.

**What it covers:**

- `assistant_thread_started` / `assistant_thread_context_changed` lifecycle handlers
- `setAssistantStatus(channelId, threadTs, status)` — maps to `assistant.threads.setStatus`
- `setSuggestedPrompts(channelId, threadTs, prompts, title?)`
- `setAssistantTitle(channelId, threadTs, title)`
- `thread.post()` with `StreamingPlan` for streamed text replies
- HMAC signature verification via `signingSecret` (customizable with `webhookVerifier`)
- Its own HTTP abstraction (webhook or socket mode), not Hono

**Critical gaps:**

- `StreamingPlan` only exposes `append()` / `stop()` / a getter for `ts`. The surface for
  `task_update` chunks and `taskDisplayMode` is **not documented and not exposed**. The
  underlying calls are `chat.startStream / appendStream / stopStream`, but the adapter's
  abstraction layer sits above those and does not pass `taskDisplayMode` or `task_update` chunks
  through to callers.
- `loading_messages` on `setStatus` — not documented as exposed.
- The adapter brings its **own HTTP layer** (webhook receiver / socket mode). Sym runs on Hono.
  Integrating means either replacing Hono or running two servers.
- Abstracts away the raw event normalization (app_mention, dm, mpim, shortcut, slash_command)
  behind its own model — Sym's carefully-crafted normalization logic (mpim @-mention gating,
  assistant container lifecycle, reply-to-self dedup) does not map cleanly onto chat-sdk's
  handler model.
- The SDK is Vercel-ecosystem-oriented. It brings an opinionated multi-workspace/OAuth model
  that Sym does not need (single-tenant, env-configured).

**Bottom line on chat-sdk:** Even though it covers the surface API names, it does not expose
`task_update` chunks or `taskDisplayMode`, which are core to Sym's streaming UX (the grouped plan
card). Adopting it would require either forking the adapter or bypassing it for every streaming
call — defeating the purpose.

### 2b. `@slack/web-api` (official Slack SDK, v7.16.0)

**What it covers — confirmed from source:**

All six of Sym's critical low-level methods are typed in `methods.ts`:

- `chatStartStream` — `ChatStartStreamArguments` (channel, thread_ts, recipient_user_id,
  recipient_team_id, markdown_text, task_display_mode, chunks)
- `chatAppendStream` — `ChatAppendStreamArguments` (channel, ts, markdown_text, chunks)
- `chatStopStream` — `ChatStopStreamArguments` (channel, ts, blocks, chunks)
- `assistantThreadsSetStatus` — `AssistantThreadsSetStatusArguments` (channel_id, thread_ts,
  status, loading_messages)
- `assistantThreadsSetSuggestedPrompts`
- `assistantThreadsSetTitle`

The SDK also provides a higher-level `chatStream()` method returning a `ChatStreamer` with
`append()` / `stop()`. `ChatStreamer` internally calls the three low-level methods.

**Critical limitations:**

1. **Transport model mismatch.** `@slack/web-api` uses an internal `axios`-based transport (not
   native `fetch`). Sym's `WebApiSlackClient` uses plain `fetch`, which is already available
   globally in Node 18+ and avoids the axios bundle. Adopting `WebClient` would add axios as a
   dependency.

2. **Retry layer.** Sym has a purpose-built retry layer (`retry.ts`) with specific idempotent
   error handling (`already_reacted`, `no_reaction` → no-op), the `loading_messages` 10-item
   slice, and the auth-revoked console.error operator signal. `WebClient` has its own retry but
   it is not tuned for these specifics.

3. **Form vs JSON dispatch.** `@slack/web-api` does the right thing (form-encoded for read
   methods, JSON for write methods) but its transport is abstracted differently than Sym's
   explicit `dispatch` / `callForm` pattern.

4. **Typed responses.** The main benefit of `@slack/web-api` would be typed request/response
   shapes. Sym's types (`types.ts`) are lean and purpose-built; they cover exactly the fields
   Sym reads. Switching would require adapting all callers to the SDK's wider types, which name
   fields differently (e.g., `channel_id` vs Sym's `channelId`) — that's an interface churn
   across `stream-reply.ts`, `task-card-manager.ts`, the event router, and the kernel.

5. **No HTTP server.** `@slack/web-api` is a pure API client — no server concerns. This is
   actually an advantage; it would not conflict with Hono.

### 2c. `@slack/bolt`

Bolt is a full framework: it brings its own HTTP receiver (supports Express adapters; no Hono
adapter exists). It wraps `@slack/web-api` internally. It handles event routing, middleware, and
the assistant API with a convenience `App.assistant()` helper.

**Why it doesn't fit:**

- Requires replacing (or wrapping) Sym's Hono server with Bolt's receiver or a custom adapter.
  There is no official Hono receiver; building one is non-trivial.
- Bolt's assistant module provides `setStatus / setSuggestedPrompts / setTitle` convenience
  wrappers but again does not expose `task_update` chunks or `taskDisplayMode`.
- Opinionated event routing would conflict with Sym's owner-gate, dedup, and multi-surface
  normalization logic.
- Brings significantly more surface area (middleware, listeners, OAuth handling) for a use-case
  Sym handles in ~300 lines of focused code.

---

## 3. Requirement Matrix

| Requirement                                        | `@chat-adapter/slack`                | `@slack/web-api` v7.16                    | `@slack/bolt`         | Must stay custom                         |
| -------------------------------------------------- | ------------------------------------ | ----------------------------------------- | --------------------- | ---------------------------------------- |
| `chat.startStream` with `taskDisplayMode`          | Partial (buried, no taskDisplayMode) | **YES** (typed)                           | Via WebClient         | No — @slack/web-api has it               |
| `chat.appendStream` with `task_update` chunks      | **NO** (StreamingPlan hides chunks)  | **YES** (typed)                           | Via WebClient         | No — @slack/web-api has it               |
| `chat.stopStream` + blocks                         | Partial (StreamingPlan endWith)      | **YES** (typed)                           | Via WebClient         | No — @slack/web-api has it               |
| `assistant.threads.setStatus` + `loading_messages` | Partial (no loading_messages docs)   | **YES** (typed, loading_messages present) | YES                   | No — @slack/web-api has it               |
| `assistant.threads.setSuggestedPrompts`            | **YES**                              | **YES**                                   | YES                   | No                                       |
| `assistant.threads.setTitle`                       | **YES**                              | **YES**                                   | YES                   | No                                       |
| HMAC verify + replay protection                    | **YES** (built-in)                   | No (separate package)                     | YES (built-in)        | `verify.ts` stays (or use @slack/bolt's) |
| Custom 429 retry + idempotent no-ops               | No                                   | No (different model)                      | No                    | `retry.ts` stays                         |
| Hono-compatible (no own server)                    | **NO** (own HTTP layer)              | **YES** (API client only)                 | **NO** (own receiver) | n/a                                      |
| Raw event normalization (5 surfaces)               | **NO** (own model)                   | **YES** (no server opinion)               | **NO** (own router)   | `normalize.ts` stays                     |
| Block Kit builders + intent renderer               | **NO** (JSX cards)                   | No                                        | No                    | `blocks.ts`/`render.ts` stay             |
| Paginated reads (replies/history/users/list)       | Partial                              | **YES** (via WebClient)                   | Via WebClient         | Pagination logic stays                   |
| search.messages (user-token)                       | Unknown                              | **YES**                                   | Via WebClient         | No                                       |
| reminders.add, users.profile.set (xoxp)            | Unknown                              | **YES**                                   | Via WebClient         | No                                       |
| Thread history → ChatMessage mapper                | **NO**                               | **NO**                                    | **NO**                | `thread.ts` stays                        |
| Receipt → context block                            | **NO**                               | **NO**                                    | **NO**                | `receipt.ts` stays                       |

---

## 4. Partial Adoption Assessment: `@slack/web-api` as the Transport

The one scenario worth examining seriously is: **replace `WebApiSlackClient`'s raw `fetch` calls
with `@slack/web-api`'s `WebClient`, but keep all the Sym-specific layers on top.**

### What you'd gain

- Official Slack types for request params and responses (instead of Sym's hand-rolled `types.ts`)
- `chatStartStream / chatAppendStream / chatStopStream` with full type coverage including
  `task_update` chunks and `taskDisplayMode`
- Automatic handling of form-vs-JSON dispatch per-method
- `ChatStreamer` as an optional higher-level helper (though Sym's streaming logic is more
  sophisticated — lazy open, buffer-mode, keepalive — so `ChatStreamer` wouldn't be used directly)

### What you'd give up / have to rework

- **Transport:** `WebClient` uses axios internally; Sym currently uses native `fetch`. Adding
  axios is ~14 kB extra on the deploy image, not a dealbreaker but not zero.
- **Interface churn:** All 17 methods on `SlackClient` take Sym's branded types
  (`SlackChannelId`, `SlackThreadTs`, `SlackUserId` from `@sym/contracts`). `WebClient` uses
  plain strings. Every call site would need wrapping or casting.
- **Retry logic:** Sym's `retry.ts` has specific behavior (idempotent `already_reacted` no-op,
  auth-revoked logging, `loading_messages` slice). Bridging to `WebClient`'s retry config would
  need careful testing.
- **The mock in tests:** Current tests inject a `SlackClient` mock. If the underlying impl
  changed to `WebClient`, the test boundary stays the same (mocking `SlackClient`) — this is
  actually fine.
- **All the non-transport layers stay unchanged:** `verify.ts`, `normalize.ts`, `blocks.ts`,
  `render.ts`, `thread.ts`, `receipt.ts`, `retry.ts` — none of these are transport concerns.

### Effort estimate

- Medium: ~2–3 days to swap the transport, run real-wire tests, verify streaming still works
  end-to-end (especially `task_update` chunks with `taskDisplayMode: 'plan'`).
- Risk: axios vs fetch behavioral differences on timeout / abort; `ChatStreamer` internals are
  opaque and not needed; the typed response shapes would require adapting mappers.

### Is it worth it?

Probably not right now. Sym's current `WebApiSlackClient` is ~480 lines and handles the exact
15 methods it needs. The SDK's streaming types would be the only real gain — and Sym already
has working streaming with full test coverage. The churn in mappers, branded-type wrappers, and
retry-layer reconciliation costs more than the benefit of having official types that Sym mostly
ignores (it reads a small subset of each response).

**Verdict on partial adoption: not worth it at current scale.** Revisit when `@slack/web-api`
drops axios for native fetch, or when Sym has many more consumers of the `SlackClient` interface
that would benefit from the richer official types.

---

## 5. Final Verdict

**Stay custom.** All three candidates fail on at least one hard requirement:

- `@chat-adapter/slack`: No `task_update` chunks, no `taskDisplayMode`, own HTTP layer
  incompatible with Hono, own event model incompatible with Sym's normalization.
- `@slack/web-api`: The types are correct and full coverage is confirmed, but replacing the
  transport is medium effort for zero functional gain — all custom layers stay.
- `@slack/bolt`: Own HTTP receiver (no Hono support), own event router, no `task_update`
  chunk exposure.

The streaming API (`chat.startStream / appendStream / stopStream`) with `task_update` chunks and
`taskDisplayMode: 'plan'` is the decisive blocker for both `@chat-adapter/slack` and `@slack/bolt`.
`@slack/web-api` does type these correctly, but replacing Sym's transport with it is not worth
the churn.

`packages/adapter/slack` should stay exactly as-is. The code is well-bounded, fully tested, and
tightly matched to Sym's actual usage. The only future trigger for revisiting would be:

1. `@slack/web-api` dropping axios for native fetch (closing the transport mismatch), or
2. Sym needing significantly more Slack API surface (e.g., full Block Kit interactivity) where
   the official types would prevent drift.

---

## 6. Sources

- `packages/adapter/slack/src/` — read in full during this assessment
- `apps/agent/src/stream-reply.ts`, `task-card-manager.ts` — streaming usage confirmed
- https://chat-sdk.dev/adapters/official/slack — WebFetch, 2026-06-04
- https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/src/methods.ts — method
  definitions confirmed via WebFetch: all 6 critical methods typed
- https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/src/chat-stream.ts —
  `ChatStreamer` confirmed wrapping start/append/stopStream
- https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/src/types/request/assistant.ts
  — `AssistantThreadsSetStatusArguments` with `loading_messages` confirmed
- `@slack/web-api` current version: **7.16.0** (from docs.slack.dev reference)
