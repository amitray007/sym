# Architecture

Sym is a single-tenant Slack AI bot: one Hono server, one pnpm workspace,
one deployable. This document is a stable bird's-eye view — a "codemap" for
occasional contributors who want to understand the shape before diving into
code. It is not a design doc and is not updated on every commit.

---

## Two-tier model

Sym has two distinct architectural tiers that must not be confused:

**Conversational tier — stateless.** Every Slack message triggers a fresh
round-trip: fetch thread, run Pi loop, stream reply, done. No messages are
persisted anywhere by Sym. The Slack thread is the memory. "Stateless" in Sym
always refers to this tier only.

**Control tier — intentional local state.** The `sym` operator CLI — with a
simple interactive menu — lets the owner manage MCP connectors and their OAuth
tokens, which
are stored in an AES-256-GCM-encrypted SQLite database (`credentials.db`).
This is the extension plane — where you wire in external MCP servers and
rotate their credentials. It has state because credentials have state; that
is by design.

---

## Codemap

### Packages

| Package                  | npm name             | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`     | `@sym/contracts`     | All shared TypeScript types: domain models (`Turn`, `Reply`, `ChatMessage`, `OwnerIdentity`), tool descriptor interfaces, render primitives (`RenderIntent`), Slack event shapes. Zero runtime code; `sideEffects: false`.                                                                                                                                                                                                                                |
| `packages/kernel`        | `@sym/kernel`        | Prompt assembly (`buildSystemPrompt`, `buildUserTurnContent`), receipt formatting (`buildReceipt`), and the `ToolRegistry` null-object that wires descriptors to dispatch functions. No I/O, no Slack dependency.                                                                                                                                                                                                                                         |
| `packages/adapter/slack` | `@sym/adapter-slack` | The complete Slack integration surface: `SlackClient` interface + `WebApiSlackClient` implementation, Block Kit rendering pipeline, render-intent → Slack blocks, event normalisation, signature verification, thread fetching, receipt → footer fields, retry helpers.                                                                                                                                                                                   |
| `packages/mcp-runtime`   | `@sym/mcp-runtime`   | The reusable MCP connector runtime: connection pool + `McpDispatcher` (`pool.ts`), live hot-reload reconcile (`reconcile.ts`), per-connector introspect/test (`introspect.ts`), the AES-256-GCM SQLite credential store (`store.ts`), transport builder (`inject.ts`), the `ConnectorConfig` schema + Zod parsers, config-file source, `CompositeDispatcher`, OAuth registry + providers. Depends only on `@modelcontextprotocol/sdk` + `@sym/contracts`. |
| `apps/agent`             | `@sym/agent`         | The runnable server — mounts all the above and adds routing, the Pi loop, the MCP connector pool, operator CLI, and config.                                                                                                                                                                                                                                                                                                                               |

**Dependency DAG** (enforced by dependency-cruiser):

```
                 @sym/contracts
        ↑              ↑               ↑
  @sym/kernel   @sym/mcp-runtime   @sym/adapter-slack
        └──────────────┴───────────────┘
                       ↑
                  @sym/agent   (depends on all three)
```

`packages/*` never import from `apps/*`. `@sym/contracts` imports nothing in
`@sym/*`. Circular dependencies are a CI error.

### `apps/agent/src` — module map

| Module / directory     | Purpose                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`            | Hono entry point. Registers all HTTP routes: `/slack/events`, `/slack/commands`, `/slack/interactivity`, `/oauth/callback/:slug`, `/health`, and the `/admin/*` loopback surface. Loads workspace context at boot.                                                                                                                                          |
| `event-router.ts`      | Extracted closures for `processEvent`, `processSlashCommand`, `processInteractivity`. Called by `server.ts`; owns the dedup window and the async dispatch to `handleTurn`.                                                                                                                                                                                  |
| `handle-turn.ts`       | **The Pi loop's sole entry point.** Builds `ToolRegistry`, wires `CompositeDispatcher` (builtins + MCP), calls `streamReply`, drives `PlanController`. Every user message passes through here exactly once.                                                                                                                                                 |
| `turn-context.ts`      | `loadTurnHistory` (thread fetch + history cap) and `loadViewedChannelContext` (assistant panel viewed-channel resolver).                                                                                                                                                                                                                                    |
| `stream-reply.ts`      | Streaming delivery helpers: `streamReply`, `runTurnLoop`, `heroRenderParts`, `clipNotif`, `finalReplyBody`.                                                                                                                                                                                                                                                 |
| `task-card-manager.ts` | State machine for the live task card: create, update steps, collapse/delete on completion.                                                                                                                                                                                                                                                                  |
| `owner-gate.ts`        | Single-owner access control. Logs + returns a denial reason; callers decide whether to reply or silently drop.                                                                                                                                                                                                                                              |
| `slack-guard.ts`       | LLM-based relevance + injection guard. Verdict is `allow` or `block`; always fails open (a guard error never silences a legitimate message).                                                                                                                                                                                                                |
| `confirmations.ts`     | Registry for pending destructive-tool confirmations. Maps `action_id` → callback; processes button clicks from `/slack/interactivity`.                                                                                                                                                                                                                      |
| `assistant.ts`         | Assistant panel lifecycle: `setTitle` + `setSuggestedPrompts` on `assistant_thread_started` and `assistant_thread_context_changed` events. Owner-gated.                                                                                                                                                                                                     |
| `builtin-tools.ts`     | Thin wiring module: imports tool handlers from `tools/` and assembles `createBuiltinDispatcher()`.                                                                                                                                                                                                                                                          |
| `tools/`               | One file per tool family. `registry.ts` owns `ALL_BUILTIN_DESCRIPTORS` and the `Map`-based dispatch table. `_helpers.ts` has shared error/arg helpers. Families: `slack-read`, `slack-write`, `slack-search`, `slack-users`, `web`, `planning`, `presentation`, `time`.                                                                                     |
| `pi/`                  | Pi agent loop. `loop.ts` — `runLoopPi` runs one turn; `meta-tools.ts` — `find_tools` + `call_tool` MCP access surface; `model.ts` — Fireworks model config; `think-router.ts` — extended thinking level selection.                                                                                                                                          |
| `cli/`                 | `sym` operator CLI. `index.ts` — command dispatch + isTTY guards; `commands/` — one file per command (status/connector/tools/secret/render); `menu.ts` — a simple `@clack/prompts` interactive menu (bare `sym` / `sym menu`); `admin-client.ts` — HTTP client for `/admin/*`; `config-store.ts` — local JSON config; `secrets.ts` — stdin-only secret set. |
| `config.ts`            | `AgentConfig` and `BehaviorConfig` — reads all env vars once at startup. Single source of truth for runtime configuration.                                                                                                                                                                                                                                  |
| `workspace-context.ts` | Boot-time Slack workspace bootstrap: resolves owner name/tz/title, validates tokens, populates `WorkspaceContext`.                                                                                                                                                                                                                                          |
| `log.ts`               | `logCtx(turnId)` — returns a `[turn <8hex>]` prefix for concurrent-turn-safe log lines.                                                                                                                                                                                                                                                                     |

---

## Architecture invariants

These are the load-bearing constraints. Any change that violates one needs an
explicit owner decision (not a PR comment).

**I-1 — The conversational tier is stateless.**
Sym persists no Slack messages, no turn history, no conversation records. The
thread fetched at the start of each turn is the only memory. The only
in-process state is the short-lived dedup window (a `Map` keyed on event ID,
cleared per-entry on ACK). A complete restart drops nothing a user would miss.

**I-2 — The control tier has intentional local state.**
The operator CLI and the AES-256-GCM SQLite credential store are
first-class architecture. They exist because MCP connectors have OAuth tokens
that must survive restarts. "No database" in Sym means no _message_ database.
The credential store is not a concession; it is required.

**I-3 — `handle-turn` is the sole Pi loop entry point.**
Nothing else calls into the Pi agent loop. The server ACKs Slack immediately,
then calls `handleTurn` in the background. Slash commands, DMs, @mentions, and
assistant panel messages all converge on `handleTurn` before the loop runs.
No other path initiates a turn.

**I-4 — The MCP dispatcher is the sole external-tool integration point.**
External MCP servers register through `mcp/pool.ts` (`McpDispatcher`) and are
surfaced to the Pi loop only through `CompositeDispatcher` in `mcp/composite.ts`.
No code outside `mcp/` may open an MCP transport or call an MCP tool directly.

**I-5 — `@sym/kernel` has no Slack dependency.**
`packages/kernel` imports only `@sym/contracts` and Node built-ins. It knows
nothing about HTTP, Slack event shapes, or the Slack API. This boundary ensures
the prompt-assembly and receipt logic can be tested without a Slack client.

**I-6 — Every privileged entry point is owner-gated or loopback-gated.**
`/slack/events` and `/slack/commands` — owner-gated (checked in `owner-gate.ts`
before any processing).
`/slack/interactivity` — confirmation buttons are owner-gated before the
callback fires.
`/admin/*` — loopback-only (IP check in `server.ts`; rejects non-127.x calls
before executing).
`/oauth/callback/:slug` — no owner-gate (the OAuth flow is user-driven), but
validates the `state` PKCE parameter.
`/health` — public read-only.

**I-7 — Server code never uses `console.log`.**
Only `console.info`, `console.warn`, and `console.error` are permitted in
`apps/agent/src` (excluding `cli/`) and in all `packages/**`. The `sym` CLI is
the only permitted user of `console.log`. This is CI-enforced (see
`ci.yml` → "No console.log outside cli/"). The reason: the CLI's `--json` mode
spies on `console.log` in-process; a server `console.log` races into the JSON
output and breaks structured output parsing.

---

## Log level convention

Log levels map to urgency, not volume:

| Level     | `console.*` call | When to use                                                                                                           |
| --------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| **error** | `console.error`  | Unrecoverable failures: a turn crashed, a connector failed to connect, an unexpected exception reached the top level. |
| **warn**  | `console.warn`   | Recoverable but notable: owner gate denied, guard blocked a message, a tool call timed out and retried.               |
| **info**  | `console.info`   | Normal operational events: turn started/completed, connector reload triggered, server booted.                         |

Log lines in the turn path are prefixed with `logCtx(turnId)` (e.g.
`[turn 1a2b3c4d]`) so concurrent turns are distinguishable in production logs
without a structured-logging framework.

---

## Per-turn latency and cost budget

Every Slack turn runs against these bounds. Exceeding them is a bug to
investigate, not a tuning parameter.

**60-second hard deadline** (`SYM_TURN_DEADLINE_MS`, default 60 000 ms).
A stuck Fireworks call or an infinite tool-call loop is aborted after 60 s.
The partial reply is delivered to Slack with a timeout notice. Set to `0` to
disable (not recommended in production). Implemented in `pi/loop.ts` via an
`AbortController` wired to a `setTimeout`.

**80-message thread history cap** (`SYM_THREAD_HISTORY_LIMIT`, default 80).
The most-recent 80 messages in the thread are sent to the model; older messages
are dropped. A 200-reply thread would otherwise re-send all 200 messages on
every turn, growing LLM cost linearly with thread length. Set to `0` to disable
the cap.

**On-demand MCP tool loading.** MCP tools are not injected into the model's
tool array on every turn (that would cost ~10k tokens per turn for "hi"). Instead,
two meta-tools — `find_tools` (search by query) and `call_tool` (execute by
exact name) — give the model on-demand access. The cost of a connector-free turn
is bounded by the number of built-in descriptors only.

**Dedup window.** Each Slack event ID is stored in an in-process `Map` for the
duration of one ACK cycle to drop Slack retries. The window is per-event, not
per-turn, and has no meaningful memory cost.

---

## Build system

pnpm workspaces + Turbo. Key conventions:

- All packages use `composite: false` in `tsconfig.json` (defers build
  ordering to Turbo, not tsc project references). <!-- audit: confirmed correct -->
- The root `tsconfig.base.json` sets `moduleResolution: NodeNext`,
  `verbatimModuleSyntax: true`, and `strict: true`.
- Each package's `vitest.config.ts` uses `pool: 'forks'` and does not set
  `globals: true` (explicit imports only). <!-- audit: DOM lib excluded -->
- `turbo.json` → `dev` task has no `dependsOn` (persistent; not a build
  dependency). `build`, `test`, `typecheck`, and `test:integration` all
  `dependsOn: ["^build"]` to ensure workspace packages are built first.
