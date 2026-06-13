# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Persona engine** — Sym speaks in one of seven voices (`sym`, `operator`,
  `sensei`, `concierge`, `hype`, `goblin`, `noir`), one active per turn. The home
  voice is set per deployment (`SYM_PERSONA`) or per channel (`sym persona set`,
  stored in an unencrypted `settings.db`); each voice's spec is editable at
  runtime via `.sym/personas/<id>.md`. Inspect and manage with the `sym persona`
  CLI.

- **MCP connector client** — Sym now ships a full MCP client (`mcp/pool.ts`,
  `mcp/reconcile.ts`, `mcp/introspect.ts`). Any stdio or remote HTTP+SSE MCP
  server can be wired in via `sym add` or the `SYM_MCP_SERVERS` env var. Tools
  are surfaced to the model on demand via two meta-tools (`find_tools`,
  `call_tool`) so connector-free turns pay no extra token cost.

- **OAuth connector support** — remote MCP servers with OAuth 2.0 / PKCE are
  supported. The `SYM_PUBLIC_URL` callback endpoint handles the redirect; tokens
  are stored encrypted in `credentials.db`. Static-token connectors are also
  supported (no OAuth needed).

- **Operator TUI and CLI** — `sym` binary provides an Ink/React terminal
  dashboard (`sym menu`) with a `SecretsManager` screen for rotating OAuth
  credentials, plus a `sym` CLI for machine-readable management
  (`sym status --json`, `sym apply`, `sym connector list`, `sym secret set`).

- **`/sym` slash command** — answers the owner from any channel or DM; replies
  ephemerally in DMs (Slack drops delayed `in_channel` in DMs), in-channel
  elsewhere. Delivers via `response_url` so the reply works even if the agent
  cannot post a seed message first.

- **Assistant panel** — Sym registers as an AI assistant in Slack's native
  panel: sets thread titles, shows suggested prompts, and streams replies into
  the panel container.

- **Block Kit rendering pipeline** — structured render intents (`table`,
  standard Markdown, grouped plan block, `present_card` / `present_table`)
  produce richer Slack replies without the agent hand-coding Block Kit JSON.

- **Live task card** — tool calls are tracked in a live "task card" that
  updates in the thread during long turns and collapses or disappears when the
  reply is delivered.

- **Per-turn deadline and thread-history cap** — `SYM_TURN_DEADLINE_MS` (60 s)
  aborts stuck model loops; `SYM_THREAD_HISTORY_LIMIT` (80 messages) keeps
  LLM cost constant regardless of thread length.

- **Confirmation buttons** — destructive tools and `run_cli` (when
  `SYM_CLI_CONFIRM=true`) pause for owner approval via Slack buttons before
  executing.

- **Hardened Docker image** — `node:24-slim` pinned by digest; `/data` volume
  for persistent CLI auth, MCP server packages, and the credential store;
  `sym` CLI exposed at `/usr/local/bin/sym` so `docker exec <container> sym
status` works without extra setup.

- **`NO_COLOR` support** — operator TUI honours the
  [`NO_COLOR`](https://no-color.org) standard; non-TTY pipe safety on
  `sym menu` / `sym tui`.

### Changed

- **Architectural collapse (2026-05-27)** — Sym was rebuilt from a
  multi-service Postgres-backed web-dashboard system into a single
  env-configured deployable. The multi-service orchestration, web dashboard,
  audit log, message database, and skill/task management subsystems were
  removed. The conversational tier is now stateless: the Slack thread is the
  memory, with no message persistence anywhere in Sym.

- **Operator tier reframing** — the TUI, CLI, and encrypted SQLite credential
  store are documented as a deliberate _control tier_ distinct from the
  stateless conversational tier, not as a contradiction of "no database."

- **`@sym/adapter-slack` consolidated** — `WebApiSlackClient` moved from
  `apps/agent/src/slack-client.ts` into the adapter package so the boundary is
  complete and reusable.

- **`builtin-tools.ts` decomposed** — the 1 679-line file with an 866-line
  if/else dispatch chain is split into `tools/` with one file per tool family
  and a `Map`-based dispatcher. Each family is independently testable.

- **`handle-turn.ts` decomposed** — per-turn orchestration extracted into
  `turn-context.ts` (history loading), `stream-reply.ts` (delivery helpers),
  and `task-card-manager.ts` (task card state), leaving `handle-turn.ts` as a
  lean orchestrator.

- **`mcp/dispatcher.ts` split** — pool, reconcile, and introspect concerns
  separated into `mcp/pool.ts`, `mcp/reconcile.ts`, and `mcp/introspect.ts`.

### Removed

- Multi-service orchestration layer, Postgres schema, web dashboard, audit log
  database, connector/skill/task management UI, and all associated service
  config. Replaced by the single `apps/agent` deployable.

- Dead setup scripts (`dev-setup.sh`, `setup-macos.sh`, `setup-linux.sh`) that
  installed Postgres and Redis and referenced a missing `pnpm db:migrate`.
  Replaced by `scripts/setup.sh`.

- Stale `dist/` build artifacts in packages that referenced deleted features
  (audit, connectors, memory, sandbox, soul types).

### Fixed

- Slack manifest prose in README had wrong bot scopes (`im:write` instead of
  `im:read`; missing `commands`, `assistant:write`). README now points at
  `pnpm manifest:render` as the source of truth; the manifest template was
  already correct.

- `console.log` CI gate added — server/package code is now blocked from using
  `console.log` (which races into the CLI's `--json` JSON output). Enforced in
  CI via a grep step.

### Security

- MCP tool `destructiveHint` is forced to `true` for all non-trusted connectors
  regardless of what the MCP server advertises — attacker-controlled annotations
  cannot bypass the confirmation gate.

- `sym secret set` is stdin-only — secrets are never accepted as positional
  arguments (which would appear in the process table).

- `/admin/*` routes are loopback-only — rejected at the IP level before any
  processing for non-127.x origins.

---

[Unreleased]: https://github.com/amitray007/sym/compare/HEAD...HEAD
