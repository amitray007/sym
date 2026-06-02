# Zone Z14: Documentation & OSS readiness

The documentation layer is the most misleading part of the codebase for an incoming OSS reader. The main README accurately describes the North Star philosophy (stateless, env-configured, no database) but dramatically under-documents the actual repo layout, the complete environment-variable surface, and the significant features that exist today — notably the `/sym` slash command, the MCP connector system, the assistant panel, and the `sym` CLI/TUI. The Slack setup instructions are dangerously stale: they list a minimal subset of required scopes and bot events that will not produce a working bot. Two setup scripts (`scripts/dev-setup.sh`, `scripts/setup-macos.sh`, `scripts/setup-linux.sh`) require Postgres 16 and Redis that the current stateless agent does not need at all. `docs/FUTURE.md` correctly records the 2026-05-27 collapse but is misleading in two directions: it lists "Connectors" as removed (the old `packages/ext/mcp` was removed, but a new full MCP client with 12 source files now lives in `apps/agent/src/mcp/`) and it does not mention the `sym` CLI/TUI which is actively present in the codebase. The PR template imports lifecycle fields (Schema/migration notes, OTel, Drizzle, stream plan codes) that belong to the removed multi-service architecture — an OSS first contributor will be confused. All seven community-health files that GitHub surfaces to new contributors are absent: `CONTRIBUTING.md`, `ARCHITECTURE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, issue templates, and `CODEOWNERS`. The LICENSE is correctly MIT with the right year. There are no README badges.

## Findings

| ID     | Severity | Category  | Title                                                                                                                                                                                                                                          | Files                                                             | Effort  |
| ------ | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| Z14-01 | high     | docs      | README repository layout omits three packages, five top-level dirs                                                                                                                                                                             | `README.md:77–82`                                                 | trivial |
| Z14-02 | high     | docs      | README env-var table missing 10+ variables the agent actually reads                                                                                                                                                                            | `README.md:24–35`, `.env.example`                                 | small   |
| Z14-03 | high     | docs      | Slack setup instructions list wrong/incomplete scopes and events                                                                                                                                                                               | `README.md:42–56`                                                 | small   |
| Z14-04 | high     | dead-code | `scripts/dev-setup.sh` requires Postgres + Redis + Drizzle that no longer exist                                                                                                                                                                | `scripts/dev-setup.sh`                                            | small   |
| Z14-05 | high     | dead-code | `scripts/setup-macos.sh` and `scripts/setup-linux.sh` install Postgres 16 and Redis for a stateless agent                                                                                                                                      | `scripts/setup-macos.sh`, `scripts/setup-linux.sh`                | small   |
| Z14-06 | high     | docs      | `docs/FUTURE.md` describes MCP "Connectors" as removed but a new full MCP client (12 files) exists in apps/agent                                                                                                                               | `docs/FUTURE.md:12`, `apps/agent/src/mcp/`                        | small   |
| Z14-07 | high     | docs      | README "How it works" entirely omits `/sym` slash command, assistant panel, MCP connectors, and `sym` CLI                                                                                                                                      | `README.md:9–19`                                                  | small   |
| Z14-08 | high     | docs      | No CONTRIBUTING.md — first OSS contributor has no orientation                                                                                                                                                                                  | (missing file)                                                    | medium  |
| Z14-09 | high     | docs      | No ARCHITECTURE.md — codebase has non-obvious layering; newcomers have no mental model                                                                                                                                                         | (missing file)                                                    | large   |
| Z14-10 | medium   | docs      | PR template contains stale "Schema/migration notes", "Audit+OTel", and "Stream" sections from the removed multi-service architecture                                                                                                           | `.github/pull_request_template.md:12–48`                          | small   |
| Z14-11 | medium   | docs      | CI workflow references `packages/memory` and `packages/soul` in evals job that are removed packages                                                                                                                                            | `.github/workflows/ci.yml:64–76`                                  | trivial |
| Z14-12 | medium   | docs      | `docs/FUTURE.md` does not mention the `sym` CLI / TUI that is actively present in the codebase                                                                                                                                                 | `docs/FUTURE.md`, `apps/agent/src/cli/`, `apps/agent/src/tui/`    | small   |
| Z14-13 | medium   | docs      | `.env.example` missing 9 env vars the agent actually reads: `SYM_MCP_SERVERS`, `SYM_CONFIG_PATH`, `SYM_ENCRYPTION_KEY`, `SYM_DB_PATH`, `SYM_PUBLIC_URL`, `SYM_MCP_CONNECT_TIMEOUT_MS`, `SYM_CLI_ALLOWLIST`, `SYM_CLI_CONFIRM`, `SYM_ADMIN_URL` | `.env.example`                                                    | small   |
| Z14-14 | medium   | docs      | `.env.example` missing `SLACK_PUBLIC_BASE_URL` (required for `pnpm manifest:render`)                                                                                                                                                           | `.env.example`, `scripts/render-manifest.js:18`                   | trivial |
| Z14-15 | medium   | docs      | `dokploy/apps/agent.yml` has a live `TODO: dockerfile:` comment suggesting the config is incomplete                                                                                                                                            | `dokploy/apps/agent.yml:13`                                       | trivial |
| Z14-16 | medium   | docs      | `dokploy/apps/agent.yml` env list omits all MCP/connector vars present in mcp-setup.md                                                                                                                                                         | `dokploy/apps/agent.yml`                                          | small   |
| Z14-17 | medium   | docs      | README `##License` says "Private OSS / internal use; not published to public npm" — this contradicts the open-sourcing intent                                                                                                                  | `README.md:86`                                                    | trivial |
| Z14-18 | medium   | docs      | README setup step 2 lists `im:write` bot scope that is not in the manifest template; `commands` and `assistant:write` scopes are required but missing from the README                                                                          | `README.md:44–46`, `slack/manifest.template.yml`                  | small   |
| Z14-19 | medium   | docs      | README setup step 5 subscribes to only `app_mention` and `message.im` — missing `message.mpim`, `assistant_thread_started`, `assistant_thread_context_changed`                                                                                 | `README.md:53`                                                    | trivial |
| Z14-20 | medium   | docs      | README `Setup` section has no mention of the manifest template / `pnpm manifest:render` workflow; newcomer will manually enter wrong scopes into the Slack UI                                                                                  | `README.md:39–73`, `slack/README.md`                              | small   |
| Z14-21 | medium   | docs      | `mcp-setup.md` references an in-progress OAuth "C3b" with internal chunk notation — opaque to a public reader                                                                                                                                  | `docs/mcp-setup.md:339`                                           | trivial |
| Z14-22 | medium   | docs      | No SECURITY.md — no responsible disclosure policy or note about the single-owner model security boundary                                                                                                                                       | (missing file)                                                    | small   |
| Z14-23 | medium   | docs      | No CHANGELOG.md — OSS users and contributors have no record of what changed and when                                                                                                                                                           | (missing file)                                                    | medium  |
| Z14-24 | low      | docs      | No CODE_OF_CONDUCT.md — standard expectation for public OSS repos                                                                                                                                                                              | (missing file)                                                    | trivial |
| Z14-25 | low      | docs      | No `.github/ISSUE_TEMPLATE/` directory — no bug/feature request templates                                                                                                                                                                      | (missing directory)                                               | small   |
| Z14-26 | low      | docs      | No README badges (CI status, license) — standard OSS credibility signal                                                                                                                                                                        | `README.md:1`                                                     | trivial |
| Z14-27 | low      | docs      | No `CODEOWNERS` file — no automated PR review routing for OSS contributors                                                                                                                                                                     | (missing file)                                                    | trivial |
| Z14-28 | low      | docs      | `package.json` missing `repository`, `homepage`, `bugs`, and `author` fields — required for npm package info pages even for private packages                                                                                                   | `package.json`                                                    | trivial |
| Z14-29 | low      | docs      | `docs/FUTURE.md` lists "Connectors" old path `packages/ext/mcp` which never existed under that path in the current repo — confusing to anyone checking git history                                                                             | `docs/FUTURE.md:12`                                               | trivial |
| Z14-30 | low      | docs      | `.claude/skills/cross-unit-impact/SKILL.md` describes "Sym is config-as-database with two services sharing one Postgres" — entirely stale since the collapse                                                                                   | `.claude/skills/cross-unit-impact/SKILL.md:10,52`                 | small   |
| Z14-31 | low      | docs      | README `How it works` omits `docker-compose.yml` as a run option; newcomer reads only `pnpm dev`                                                                                                                                               | `README.md:63–73`, `docker-compose.yml`                           | trivial |
| Z14-32 | low      | docs      | `dokploy/env-template.txt` has `AGENT_URL` but this var is not in `.env.example`, `README.md`, or `dokploy/README.md`; its purpose (post-deploy smoke test only) is not documented                                                             | `dokploy/env-template.txt`, `dokploy/deploy-hooks/post-deploy.sh` | trivial |
| Z14-33 | low      | ai-slop   | `mcp-setup.md` uses "Model A / Model B" terminology that is internal design language, not standard terminology — a public reader has no context                                                                                                | `docs/mcp-setup.md:128–152`                                       | small   |
| Z14-34 | low      | docs      | No `examples/` directory — a common OSS convention to provide sample connector configs, a `.env.example` walkthrough, or a sample `config.json`                                                                                                | (missing directory)                                               | medium  |

## Detail

### Z14-01 — README repository layout omits three packages, five top-level dirs

**Evidence.** `README.md:77–82` shows only:

```
apps/
  agent/    Hono server — Slack events → Pi agent loop → Fireworks reply
docs/
  FUTURE.md Parked features …
```

The actual tree includes: `packages/contracts`, `packages/kernel`, `packages/adapter/slack`, `slack/` (manifest template), `dokploy/` (deployment config), `scripts/` (setup scripts), `assets/` (avatars), and `Dockerfile` / `docker-compose.yml`. `docs/FUTURE.md:25` itself says "4 kept packages" — the README layout shows none of them.

**Recommendation.** Expand the `## Repository layout` section to a full tree matching the actual structure, with a one-line description per entry.

---

### Z14-02 — README env-var table missing 10+ variables the agent reads

**Evidence.** `README.md:24–35` table covers 9 variables. Searching `apps/agent/src/**` for `process.env[` finds these additional variables the agent uses but are absent from the README table:

| Var                          | Where read               |
| ---------------------------- | ------------------------ |
| `SLACK_OWNER_USER_TOKEN`     | `config.ts:93`           |
| `TASK_CARD_THRESHOLD`        | `config.ts:103`          |
| `TASK_CARD_AFTER`            | `config.ts:104`          |
| `OWNER_POST_MARKER`          | `config.ts:105`          |
| `SYM_MCP_SERVERS`            | `mcp/source.ts:137`      |
| `SYM_CONFIG_PATH`            | `mcp/source.ts:44`       |
| `SYM_ENCRYPTION_KEY`         | `mcp/store.ts`           |
| `SYM_DB_PATH`                | `mcp/store.ts`           |
| `SYM_PUBLIC_URL`             | `mcp/providers/oauth.ts` |
| `SYM_MCP_CONNECT_TIMEOUT_MS` | `mcp/dispatcher.ts`      |
| `SYM_CLI_ALLOWLIST`          | `run-cli.ts`             |
| `SYM_CLI_CONFIRM`            | `pi/loop.ts`             |
| `SYM_ADMIN_URL`              | `cli/admin-client.ts`    |

All are absent from the README table and most are absent from `.env.example` (see Z14-13).

**Recommendation.** Add all env vars to the README table, grouped by concern (Slack / LLM / Agent server / MCP connectors / Behavior controls), with accurate required/optional markers and defaults.

---

### Z14-03 — Slack setup instructions list wrong/incomplete scopes and events

**Evidence.** `README.md:44–46` instructs:

```
- `app_mentions:read`, `channels:history`, `channels:read`
- `chat:write`, `groups:history`, `im:history`, `im:write`
- `mpim:history`, `users:read`
```

`slack/manifest.template.yml` is the authoritative source. The manifest has many more bot scopes (`assistant:write`, `commands`, `files:read`, `groups:read`, `im:read`, `mpim:read`, `users:read.email`) and a full set of user scopes (`search:read`, `chat:write`, `reactions:write`, `users.profile:write`, `reminders:write/read`, `canvases:read/write`, `emoji:read`). `im:write` in the README has no matching entry in the manifest. `commands` (required for `/sym`) is absent from the README list.

`README.md:53` says subscribe to `app_mention` and `message.im`. The manifest needs three more: `message.mpim`, `assistant_thread_started`, `assistant_thread_context_changed`.

The README also omits: enabling the Interactivity Request URL, enabling the slash command `/sym`, and the OAuth redirect URL — all required for full functionality.

**Recommendation.** Replace the manual scope/event list in the README with a pointer to `slack/README.md` and `pnpm manifest:render`. The manifest is the single source of truth; the README should say so.

---

### Z14-04 — `scripts/dev-setup.sh` requires Postgres + Redis + Drizzle that no longer exist

**Evidence.** `scripts/dev-setup.sh:27–32`:

```sh
command -v redis-cli … || die "redis-cli not found."
pg_isready -q 2>/dev/null || die "Postgres is not running."
```

`scripts/dev-setup.sh:77–78`:

```sh
log "Running DB migrations (pnpm db:migrate) …"
pnpm db:migrate
```

`scripts/dev-setup.sh:84–90`:

```
log "  Postgres : …"
log "  Redis    : …"
log "  pnpm db:studio      — open Drizzle Studio"
```

None of `packages/db`, `pnpm db:migrate`, or Drizzle Studio exist in the current codebase. Running this script errors immediately after `psql` not found, or — worse — after both services start, at `pnpm db:migrate` (no such script).

**Recommendation.** Rewrite `scripts/dev-setup.sh` to reflect the current stateless stack: copy `.env.example` → `.env`, run `pnpm install`, generate a `SYM_ENCRYPTION_KEY` (still needed for OAuth connectors). Remove all Postgres/Redis/Drizzle steps.

---

### Z14-05 — `scripts/setup-macos.sh` and `scripts/setup-linux.sh` install services the current agent does not need

**Evidence.** `scripts/setup-macos.sh` installs `postgresql@16` and `redis` via Homebrew and starts their services. `scripts/setup-linux.sh` does the same via apt. The scripts then say "Next step: sh scripts/dev-setup.sh", which calls `pnpm db:migrate`. A newcomer running these scripts will install and start two services that serve no purpose and will then hit a `pnpm db:migrate` failure.

**Recommendation.** Replace both setup scripts with a minimal "prerequisites" check: Node 24, pnpm 10, and optionally ngrok for tunnelling. Remove all Postgres and Redis installation.

---

### Z14-06 — `docs/FUTURE.md` says MCP "Connectors" were removed, but a new MCP client was implemented in apps/agent

**Evidence.** `docs/FUTURE.md:12`:

```
- **Connectors** — MCP HTTP tool registry (`packages/ext/mcp`, `packages/ext/skills`)
```

The text says "The following were removed and can be restored from git history if revisited." However, `apps/agent/src/mcp/` currently contains 12 TypeScript source files implementing a full MCP client (stdio + HTTP transports, static/ambient/oauth auth, the `sym` CLI, config file reloading, admin routes). This is not "removed" — it is the primary integration capability of the agent. The document creates a false impression.

**Recommendation.** Add a "Rebuilt in-agent (2026-06)" section to `FUTURE.md` that notes the new MCP client (`apps/agent/src/mcp/`) and points to `docs/mcp-setup.md`. Keep the "removed from packages/" note for the old architecture.

---

### Z14-07 — README "How it works" entirely omits slash commands, assistant panel, MCP connectors, and the `sym` CLI

**Evidence.** `README.md:9–19` describes only: Slack event → verify → owner gate → fetch thread → Pi loop → reply. Not mentioned:

- `/sym <prompt>` slash command (`server.ts:501`)
- Slack assistant panel (`assistant_thread_started` / `assistant_thread_context_changed` handlers)
- MCP connectors (12 source files, `docs/mcp-setup.md` is entirely about this)
- The `sym` CLI / TUI for managing connectors and secrets
- Confirmation flow for destructive MCP tool calls
- Admin routes (`/admin/status`, `/admin/reload`, `/admin/connectors`)
- OAuth callback (`/oauth/callback/:slug`)

A newcomer reading only the README has a severely incomplete model of what the agent does.

**Recommendation.** Expand "How it works" to cover the main invocation surfaces (events, slash commands, assistant panel) and the extension point (MCP connectors via `docs/mcp-setup.md`).

---

### Z14-08 — No CONTRIBUTING.md

**Evidence.** `ls /Users/maverick/code/projects/sym/CONTRIBUTING.md` returns nothing. There is no contributor orientation document in the repo root or `.github/`.

**Recommendation.** Create `CONTRIBUTING.md` covering: prerequisites (Node 24, pnpm 10), `pnpm install && pnpm dev`, running tests (`pnpm test`), the team conventions (chunk-per-PR, test-first, console.info not console.log, tests in `tests/` not co-located), how to get a Slack dev workspace for integration testing, and a pointer to `ARCHITECTURE.md` (Z14-09).

---

### Z14-09 — No ARCHITECTURE.md

**Evidence.** No `ARCHITECTURE.md` exists. The codebase has non-obvious layering: `packages/contracts` (branded types) → `packages/kernel` (prompt builders, ToolRegistry) → `packages/adapter/slack` (Slack API client, normalisation, Block Kit) → `apps/agent` (HTTP surface, Pi loop, MCP client, CLI/TUI). A newcomer has no written mental model. The relationships between these packages — which one is "dumb types", which one orchestrates, why the Slack adapter is a separate package, why `packages/kernel` still exists after the old `runLoop` was retired — are not documented anywhere in the repo.

**Recommendation.** Create `ARCHITECTURE.md` covering: the four-layer diagram (contracts → kernel → adapter → agent), what Pi is (why it is used, what it provides), the stateless memory model (thread-as-memory), the MCP connector model, the `sym` CLI control plane, and the distinction between "built-in tools" and "MCP tools". This document is the highest-value OSS contribution of this refactor.

---

### Z14-10 — PR template has stale schema/migration, OTel, and stream-plan sections

**Evidence.** `.github/pull_request_template.md:12–13`:

```
## Stream
<!-- Which build-plan stream owns this change? e.g. Sp1, Sp2, S1, S7a, S8 -->
```

`Sp1`, `S7a`, `S8` are internal build-plan codes from the old multi-service era that are not documented anywhere a new contributor could find. Lines 37, 40–49 require "Audit + OTel" event names, Drizzle migration checklist items (additive only? NOT NULL after backfill? Drizzle types regenerated?), and `packages/db/` as a section trigger — all of which reference removed infrastructure.

**Recommendation.** Remove the "Stream" section entirely or replace it with "Chunk" + link to build plan. Remove the "Schema / migration notes" section. Simplify "Audit + OTel added" to "Logging added" or remove it. The template should reflect the current single-service stateless architecture.

---

### Z14-11 — CI workflow references removed `packages/memory` and `packages/soul`

**Evidence.** `.github/workflows/ci.yml:64–76`:

```yaml
# when packages/memory and packages/soul ship their promptfoo configs.
# Runs only on PRs touching memory, soul, or kernel packages.
# TODO(S7a): pnpm --filter @sym/memory exec promptfoo eval --ci
# TODO(S7d): pnpm --filter @sym/soul exec promptfoo eval --ci
```

Both `packages/memory` and `packages/soul` were removed in the 2026-05-27 collapse. The `if: false` guard means this job never runs, so it causes no harm, but the comments mislead a reader into thinking these packages might return.

**Recommendation.** Either remove the `evals` job entirely, or replace it with a clear comment: "Eval harness placeholder — wire when a promptfoo config exists in any package." Remove the references to `memory` and `soul`.

---

### Z14-12 — `docs/FUTURE.md` does not mention the `sym` CLI / TUI that is present in the codebase

**Evidence.** `docs/FUTURE.md` lists what was removed. It also says "Still present (the 4 kept packages): `apps/agent`, `packages/adapter/slack`, `packages/kernel`, `packages/contracts`." But it does not mention that `apps/agent` contains a full CLI (`apps/agent/src/cli/`) and a TUI (`apps/agent/src/tui/`) with four screens (Dashboard, DetailScreen, BuilderScreen, SecretsManager). `docs/FUTURE.md:17` lists "**Secrets** — libsodium encrypt/decrypt (`packages/secrets`)" as removed, which is true for the old package, but the TUI has a SecretsManager screen for a new encrypted secrets store. This is confusing — a reader could conclude that the secrets capability is gone, but it was reimplemented.

**Recommendation.** Update `FUTURE.md` to note what was rebuilt in-agent after the collapse: MCP client (stdio + HTTP), `sym` CLI, TUI, encrypted credential store. The document's "removed" list should only cover things that are genuinely gone with no replacement.

---

### Z14-13 — `.env.example` missing 9 env vars the agent reads

**Evidence.** `grep process.env\[` across `apps/agent/src/` finds these variables absent from `.env.example`: `SYM_MCP_SERVERS`, `SYM_CONFIG_PATH`, `SYM_ENCRYPTION_KEY`, `SYM_DB_PATH`, `SYM_PUBLIC_URL`, `SYM_MCP_CONNECT_TIMEOUT_MS`, `SYM_CLI_ALLOWLIST`, `SYM_CLI_CONFIRM`, `SYM_ADMIN_URL`. Most of these are important for connector setup (the primary extension point). The Dockerfile (`Dockerfile:71–72`) sets some defaults for deploy context (`SYM_DB_PATH=/data/credentials.db`, `SYM_CONFIG_PATH=/data/sym/config.json`) but these are not in `.env.example` for local development.

**Recommendation.** Add an MCP/connector section to `.env.example` with all nine vars, marked optional with their defaults. For vars with deploy-specific defaults different from local defaults, add a comment explaining both.

---

### Z14-14 — `.env.example` missing `SLACK_PUBLIC_BASE_URL`

**Evidence.** `scripts/render-manifest.js:18` requires `SLACK_PUBLIC_BASE_URL` from the environment (`process.env.SLACK_PUBLIC_BASE_URL`). Running `pnpm manifest:render` without it fails with an error message. The `slack/README.md` documents it. But `.env.example` has no entry for it, so a newcomer's first run of `pnpm manifest:render` will fail without explanation unless they read the slack README.

**Recommendation.** Add `SLACK_PUBLIC_BASE_URL=` with a comment to `.env.example` in the Slack section.

---

### Z14-15 — `dokploy/apps/agent.yml` has live `TODO: dockerfile:` comment

**Evidence.** `dokploy/apps/agent.yml:13`:

```yaml
# TODO: dockerfile: apps/agent/Dockerfile
```

The Dockerfile lives at the repo root (`/Dockerfile`), not at `apps/agent/Dockerfile`. This TODO has been rendered moot — the root Dockerfile is the correct location (monorepo build context must be the root). The comment implies the config is incomplete when it is actually correct.

**Recommendation.** Remove the TODO comment. Add a comment clarifying that the Dockerfile at repo root is intentional (monorepo build context).

---

### Z14-16 — `dokploy/apps/agent.yml` env list omits all MCP/connector vars

**Evidence.** `dokploy/apps/agent.yml` lists only the 7 core Slack + Fireworks + port vars. The agent also reads `SYM_MCP_SERVERS`, `SYM_CONFIG_PATH`, `SYM_ENCRYPTION_KEY`, `SYM_DB_PATH`, `SYM_PUBLIC_URL`, `SYM_MCP_CONNECT_TIMEOUT_MS` at runtime. If none of these are set in Dokploy's environment tab, connectors are silently disabled with no error.

**Recommendation.** Add commented-out optional MCP vars to `dokploy/apps/agent.yml` with notes about when each is needed, consistent with `docs/mcp-setup.md`.

---

### Z14-17 — README license note contradicts the open-sourcing intent

**Evidence.** `README.md:86`:

```
MIT. Private OSS / internal use; not published to public npm. See `LICENSE`.
```

"Private OSS / internal use" is contradictory — MIT is a public open-source license. The project is about to be open-sourced. This language will read as confusing to an incoming contributor who sees MIT in the LICENSE file and "private" in the README.

**Recommendation.** Change to: `MIT — see \`LICENSE\`.` If the project will not be published to npm, that can be stated separately as a note about npm publishing. Remove "private OSS / internal use".

---

### Z14-18 — README Slack scope list contains `im:write` (not in manifest) and omits `commands` and `assistant:write`

**Evidence.** `README.md:46` lists `im:write` as a required bot scope. `slack/manifest.template.yml` does not contain `im:write` anywhere (bot posting to DMs is handled via `chat:write`). The manifest has `commands` (required for `/sym` slash commands) and `assistant:write` (required for the assistant panel) — both absent from the README scope list.

**Recommendation.** Remove `im:write` from the README scope list. Add `commands` and `assistant:write`. Best fix: point to `pnpm manifest:render` and remove manual scope enumeration (see Z14-03).

---

### Z14-19 — README event subscription list is missing three events

**Evidence.** `README.md:53`: "Subscribe to these bot events: `app_mention`, `message.im`." The manifest (`slack/manifest.template.yml`, `bot_events:`) requires: `app_mention`, `message.im`, `message.mpim`, `assistant_thread_started`, `assistant_thread_context_changed`. Missing `message.mpim` means group DMs won't work. Missing the two `assistant_thread_*` events means the AI assistant panel won't initialise.

**Recommendation.** Add all five events to the README. Better: replace the manual list with a pointer to `pnpm manifest:render` as the canonical source.

---

### Z14-20 — README Setup section omits the manifest workflow entirely

**Evidence.** `slack/README.md` describes `slack/manifest.template.yml` as the "canonical source of truth" for the Slack app — scopes, events, and feature flags — and explains `pnpm manifest:render`. The main `README.md:39–73` setup section says nothing about this. A newcomer will manually enter scopes into the Slack app UI (and get them wrong — see Z14-03/18/19) instead of using the authoritative manifest tool.

**Recommendation.** Add a step to the README Setup section: "Render the Slack manifest (`pnpm manifest:render`) and paste it into your Slack app's App Manifest tab, or use the Slack CLI." This replaces the manual scope instructions.

---

### Z14-21 — `mcp-setup.md` references an in-progress OAuth step with internal chunk notation

**Evidence.** `docs/mcp-setup.md:339`:

```
The in-Slack "Connect" button … (**C3b**) is not yet built …
```

"C3b" is an internal build-plan chunk ID meaningful only to the original author. An OSS reader sees an unexplained label. This is an instance of AI-slop internal notation leaking into user-facing docs.

**Recommendation.** Replace "(**C3b**)" with a plain English phrase: "…is not yet built — tracked for a future release."

---

### Z14-22 — No SECURITY.md

**Evidence.** No `SECURITY.md` exists. The agent uses secrets (`SLACK_BOT_TOKEN`, `FIREWORKS_API_KEY`, optionally `SYM_ENCRYPTION_KEY`). The single-owner model is a deliberate security boundary. A responsible disclosure path and a note about the security model are standard OSS requirements and GitHub surfaces them to contributors.

**Recommendation.** Create `SECURITY.md` with: responsible disclosure instructions (email or private GH security advisory), the security model (single-owner gate, loopback-only admin routes), known boundaries (`trust: false` for MCP connectors), and what to do if a secret is compromised.

---

### Z14-23 — No CHANGELOG.md

**Evidence.** No `CHANGELOG.md` exists. There are commit messages and the `docs/FUTURE.md` collapse note, but no structured release history. For an OSS project, a CHANGELOG is a first-class user-facing artifact.

**Recommendation.** Create `CHANGELOG.md` following Keep a Changelog format. Start with `[Unreleased]` and a retrospective entry for the 2026-05-27 collapse. Establish a convention (e.g. on GitHub release, update CHANGELOG).

---

### Z14-24 — No CODE_OF_CONDUCT.md

**Evidence.** No `CODE_OF_CONDUCT.md` exists. GitHub surfaces this file to new contributors. Absence is a standard OSS readiness gap.

**Recommendation.** Add `CODE_OF_CONDUCT.md` using the Contributor Covenant v2.1 boilerplate with the contact email.

---

### Z14-25 — No `.github/ISSUE_TEMPLATE/` directory

**Evidence.** `ls /Users/maverick/code/projects/sym/.github/` shows only `pull_request_template.md` and `workflows/`. No issue templates.

**Recommendation.** Add at minimum a `bug_report.md` and a `feature_request.md` issue template.

---

### Z14-26 — No README badges

**Evidence.** `README.md:1–8` has no badges. Standard OSS badges include CI status and license.

**Recommendation.** Add: CI status badge linking to GitHub Actions, MIT license badge. Optional: Node version badge.

---

### Z14-27 — No CODEOWNERS

**Evidence.** No `.github/CODEOWNERS` exists. With a single owner (Amit) this is not a correctness issue, but GitHub uses it for PR review routing and ownership attribution — standard for public repos.

**Recommendation.** Create `.github/CODEOWNERS` with `* @amitray` (or the actual GitHub username).

---

### Z14-28 — `package.json` missing `repository`, `homepage`, `bugs`, `author` fields

**Evidence.** `package.json` has `name`, `version`, `license`, `description` but no `repository`, `homepage`, `bugs`, or `author`. These fields are used by npm, GitHub, and dependency scanners.

**Recommendation.** Add `repository`, `homepage` (once the repo is public), `bugs`, and `author` fields to `package.json`.

---

### Z14-29 — `docs/FUTURE.md` lists incorrect path for old connectors package

**Evidence.** `docs/FUTURE.md:12`:

```
- **Connectors** — MCP HTTP tool registry (`packages/ext/mcp`, `packages/ext/skills`)
```

The current repo has no `packages/ext/` directory in any commit visible from the current branch. The pnpm workspace (`pnpm-workspace.yaml`) only covers `packages/*` and `packages/adapter/*` — `packages/ext/` is not a valid workspace path. This path appears to be speculative design notation that never matched actual directory structure.

**Recommendation.** Correct the path to whatever the actual removed package path was (if known from git history), or remove the path if it was never implemented.

---

### Z14-30 — `cross-unit-impact` skill describes a removed multi-service architecture

**Evidence.** `.claude/skills/cross-unit-impact/SKILL.md:10`:

```
This skill exists because Sym is config-as-database with two services sharing one Postgres.
```

And line 52:

```
Sym is two services sharing one DB. Order matters.
```

This describes the pre-collapse architecture. There is now one service and no Postgres. The skill's core checklist remains valuable (contract changes, backward compatibility, expand-contract) but the framing is wrong and the specific steps about DB migration and deploy ordering are inapplicable.

**Recommendation.** Update the skill's framing to the current single-service architecture. Keep the "name all consumers" / "backward compat" / "expand-contract" core. Remove the Postgres/two-service references.

---

### Z14-31 — README run instructions omit Docker option

**Evidence.** `README.md:63–73` shows only `pnpm install && pnpm --filter @sym/agent dev`. The repo has a `docker-compose.yml` that is a fully documented, production-equivalent run option. A newcomer who prefers Docker has no guidance.

**Recommendation.** Add a `### Using Docker` subsection pointing to `docker compose up --build`.

---

### Z14-32 — `AGENT_URL` purpose is undocumented and inconsistently present

**Evidence.** `dokploy/env-template.txt` includes `AGENT_URL=<https://agent.yourdomain.com>` but this variable does not appear in `README.md`, `dokploy/README.md`, or `.env.example`. Its actual use is in `dokploy/deploy-hooks/post-deploy.sh:10` as the smoke-test target. A deployer who misses `dokploy/README.md → Files in this directory → env-template.txt` will not set it and the post-deploy check will silently die.

**Recommendation.** Document `AGENT_URL` in `dokploy/README.md` and add it to the "Deploy" steps list as a required env var for the post-deploy hook.

---

### Z14-33 — `mcp-setup.md` uses internal "Model A / Model B" terminology

**Evidence.** `docs/mcp-setup.md:128–152` introduces "Model A" and "Model B" for credential ownership patterns without any prior introduction. These are internal design labels. A public reader needs context: "Sym holds the credential" vs "the CLI holds its own credential (ambient)". The names appear throughout a long document, making it hard to understand without re-reading the definition section.

**Recommendation.** Replace "Model A" and "Model B" in all body references with the descriptive phrases: "Sym-held credential" and "ambient credential (CLI-held)". The labels can be kept in a parenthetical for internal reference.

---

### Z14-34 — No `examples/` directory

**Evidence.** No `examples/` or `example/` directory exists. For a project where the primary extension point (MCP connectors) requires complex JSON configuration, sample configs are high value for OSS users.

**Recommendation.** Create `examples/` with: a sample `config.json` for two common connectors (e.g. sentry + gcloud), a commented `.env` walkthrough, and a "minimal setup" vs "full setup with MCP" comparison. Link from the README and `docs/mcp-setup.md`.

---

## Proposed chunks

### C1: Purge dead setup scripts and stale CI references

**Goal:** Every file a newcomer runs or reads reflects the current stateless stack — no Postgres/Redis/Drizzle confusion.
**Finding IDs:** Z14-04, Z14-05, Z14-11
**Depends on:** (nothing)

Actions:

1. Rewrite `scripts/dev-setup.sh` to: copy `.env.example` → `.env`, generate `SYM_ENCRYPTION_KEY`, run `pnpm install`. Remove all Postgres/Redis/Drizzle steps.
2. Replace `scripts/setup-macos.sh` with a minimal prerequisites check (Node 24, pnpm 10). Remove Postgres/Redis installation.
3. Replace `scripts/setup-linux.sh` same way.
4. Remove the `evals` job comments referencing `packages/memory` and `packages/soul` from `.github/workflows/ci.yml`.

---

### C2: Correct `.env.example` and expand README env-var table

**Goal:** A newcomer who reads the README and copies `.env.example` knows every env var the agent reads.
**Finding IDs:** Z14-02, Z14-13, Z14-14
**Depends on:** (nothing)

Actions:

1. Add MCP/connector section to `.env.example` with all 9 missing vars.
2. Add `SLACK_PUBLIC_BASE_URL` to `.env.example`.
3. Update README env-var table to cover all vars, grouped by concern.

---

### C3: Overhaul README — layout, How it works, Slack setup

**Goal:** README accurately describes the current repo and a newcomer can run a fully-working bot by following it.
**Finding IDs:** Z14-01, Z14-03, Z14-07, Z14-17, Z14-18, Z14-19, Z14-20, Z14-31
**Depends on:** C2 (env table)

Actions:

1. Expand `## Repository layout` to full tree.
2. Expand `## How it works` to cover slash commands, assistant panel, MCP connectors, `sym` CLI.
3. Replace manual Slack scope/event list with pointer to `slack/README.md` + `pnpm manifest:render` workflow. Remove the outdated step-by-step scope list.
4. Fix the license note from "Private OSS / internal use" to "MIT".
5. Add `### Using Docker` subsection.

---

### C4: Fix docs/FUTURE.md accuracy

**Goal:** `FUTURE.md` is honest: removed things are listed as removed; rebuilt things are noted as rebuilt.
**Finding IDs:** Z14-06, Z14-12, Z14-29
**Depends on:** (nothing)

Actions:

1. Add a "Rebuilt in-agent (2026)" section listing: MCP client (apps/agent/src/mcp/), `sym` CLI, TUI + encrypted credential store.
2. Note that MCP connectors were reimplemented in-agent (not just removed).
3. Fix or remove the `packages/ext/mcp` path reference.
4. Add a brief mention of the `sym` CLI/TUI to the "still present" list.

---

### C5: Fix PR template and cross-unit-impact skill for single-service arch

**Goal:** Contributor-facing tooling describes the current single-service stateless project, not the old multi-service one.
**Finding IDs:** Z14-10, Z14-30
**Depends on:** (nothing)

Actions:

1. Remove "Stream", "Schema / migration notes" sections from the PR template.
2. Simplify "Audit + OTel" to "Logging" or remove.
3. Update `.claude/skills/cross-unit-impact/SKILL.md` framing to single-service / no-Postgres.

---

### C6: Fix mcp-setup.md minor issues

**Goal:** `mcp-setup.md` reads as public documentation without internal notation.
**Finding IDs:** Z14-21, Z14-33
**Depends on:** (nothing)

Actions:

1. Replace "(**C3b**)" with plain English.
2. Replace "Model A / Model B" references in body text with descriptive phrases.

---

### C7: Fix miscellaneous configuration docs

**Goal:** All deployment config docs are complete and free of TODOs.
**Finding IDs:** Z14-15, Z14-16, Z14-32
**Depends on:** (nothing)

Actions:

1. Remove TODO comment from `dokploy/apps/agent.yml`.
2. Add commented optional MCP vars to `dokploy/apps/agent.yml`.
3. Document `AGENT_URL` in `dokploy/README.md`.

---

### C8: Add community health files

**Goal:** GitHub surfaces correct community health files; OSS contributors have orientation.
**Finding IDs:** Z14-08, Z14-22, Z14-23, Z14-24, Z14-25, Z14-26, Z14-27, Z14-28
**Depends on:** C3 (accurate README before writing CONTRIBUTING that references it)

Actions:

1. Create `CONTRIBUTING.md` with prerequisites, dev loop, conventions, test instructions.
2. Create `SECURITY.md` with security model + responsible disclosure.
3. Create `CHANGELOG.md` (Keep a Changelog format) with retrospective 2026-05-27 collapse entry.
4. Create `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1).
5. Create `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`.
6. Add CI status + license badges to README.
7. Create `.github/CODEOWNERS`.
8. Add `repository`, `homepage`, `bugs`, `author` to `package.json`.

---

### C9: Create ARCHITECTURE.md

**Goal:** A newcomer can understand the codebase layering and design decisions without reading all the code.
**Finding IDs:** Z14-09
**Depends on:** C3, C4 (accurate README + FUTURE.md before writing ARCHITECTURE that cross-references them)

Actions:

1. Write `ARCHITECTURE.md` covering the four-package layer diagram, Pi SDK role, stateless memory model, MCP connector model, `sym` CLI control plane, and built-in vs MCP tool distinction.

---

### C10: Add examples/ directory and `package.json` metadata

**Goal:** OSS users have sample connector configs; npm/GitHub metadata is complete.
**Finding IDs:** Z14-34
**Depends on:** C6 (clean mcp-setup.md before writing examples that reference it)

Actions:

1. Create `examples/config.json` with annotated sample connector entries (sentry, gcloud).
2. Create `examples/.env.mcp` with commented-out MCP env vars for the examples.
3. Link from README and `docs/mcp-setup.md`.
