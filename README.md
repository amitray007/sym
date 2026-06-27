# Sym

**A source-available AI teammate that lives in your Slack workspace.**

[![CI](https://github.com/amitray007/sym/actions/workflows/ci.yml/badge.svg)](https://github.com/amitray007/sym/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#status)

> [!WARNING]
> **Early research & development — experimental.** Sym is an early-stage
> research project shared for experimentation, learning, and feedback. It is
> **not** production-ready: expect breaking changes, rough edges, incomplete
> features, and no stability or security guarantees. Run it at your own risk,
> and don't point it at anything you can't afford to break. See [Status](#status).

Sym is a single-tenant, single-deployable Slack bot. DM it, @mention it, or use `/sym <prompt>` from any channel. It replies inline in threads using rich Slack Block Kit formatting, with a live task card that tracks tool calls as they happen. Its primary extension surface is the [Model Context Protocol (MCP)](https://modelcontextprotocol.io): wire in any MCP server via the `sym` CLI and its tools are immediately available to the agent in every conversation.

---

## Table of contents

- [Status](#status)
- [Key features](#key-features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Slack app setup](#slack-app-setup)
- [Usage](#usage)
- [MCP connectors](#mcp-connectors)
- [Development](#development)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Status

**Sym is in early research and development.** It is an experimental project,
published to explore the design of a Slack-native, MCP-first AI teammate and to
gather feedback. Treat it accordingly:

- **Not production-ready.** Interfaces, configuration, and behavior can change
  without notice or migration paths.
- **No guarantees.** No stability, support, or security guarantees are implied;
  the software is provided "as is" (see [LICENSE](LICENSE)).
- **For experimentation.** Best suited to personal labs, learning, and
  evaluation — not for handling sensitive data or critical workflows.

Issues and ideas are welcome via [GitHub Discussions](https://github.com/amitray007/sym/discussions)
and the issue tracker.

---

## Key features

- **Slack-native** — responds to DMs, @mentions, `/sym` slash commands, and the
  native Slack assistant panel, all through the same `handleTurn` entry point.
- **Stateless conversational tier** — no message database. The Slack thread is
  the only memory. A restart drops nothing a user would notice.
- **Rich Block Kit replies** — streams replies with a live task card that tracks
  tool calls in real time; collapses or removes on completion.
- **MCP client** — connects to MCP servers over `stdio` or HTTP, with `static`,
  `oauth`, and `ambient` auth. External tools become available to the agent
  without a restart.
- **On-demand tool loading** — MCP tools are not injected into every prompt.
  Two meta-tools (`find_tools`, `call_tool`) give the model on-demand access,
  keeping the cost of a connector-free turn low.
- **`sym` operator CLI** — an interactive TUI (via `sym menu`) and a
  machine-readable flag API (`sym status --json`, `sym connector ls`, etc.) for
  managing connectors and secrets without touching a config file by hand.
- **Encrypted credential store** — OAuth tokens and static secrets are stored in
  an AES-256-GCM-encrypted SQLite database. Secrets are never echoed to the
  terminal.
- **Confirmation gate** — destructive tool calls (and `run_cli` when
  `SYM_CLI_CONFIRM=true`) pause for owner approval via Slack buttons before
  executing.
- **Single owner** — the `SYM_OWNER_SLACK_USER_ID` gate silently ignores
  messages from anyone else, making the bot safe to install in a shared workspace
  without exposing it to all members.
- **OpenTelemetry instrumentation** — model calls are traced with `gen_ai.*`
  conventions; no-op by default, zero overhead unless you register an SDK.

---

## Architecture

Sym has two architectural tiers:

**Conversational tier (stateless):** A Slack event arrives at the Hono server,
passes signature verification and the owner gate, the full thread is fetched as
context, and the Pi agent loop calls a Fireworks-hosted LLM. The reply streams
back into the thread. No state persists between turns.

**Control tier (intentional local state):** The `sym` CLI manages MCP connector
wiring and OAuth tokens stored in an encrypted SQLite credential database. This
is the extension surface — where you add or rotate connectors without restarting
the agent.

### Monorepo packages

| Package                  | npm name             | Purpose                                                                                         |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/agent`             | `@sym/agent`         | The Hono server — mounts all packages, runs the Pi loop, hosts the `sym` CLI                    |
| `packages/contracts`     | `@sym/contracts`     | Shared TypeScript types (domain models, tool interfaces, render primitives, Slack shapes)       |
| `packages/kernel`        | `@sym/kernel`        | Prompt assembly, receipt formatting, `ToolRegistry` — no Slack or I/O dependency                |
| `packages/mcp-runtime`   | `@sym/mcp-runtime`   | MCP connector pool, hot-reload reconcile, credential store, transport builder, OAuth store      |
| `packages/adapter/slack` | `@sym/adapter-slack` | Slack Web API client, Block Kit rendering pipeline, event normalisation, signature verification |

**Dependency DAG** (enforced by dependency-cruiser):

```
               @sym/contracts
      ↑               ↑                ↑
@sym/kernel   @sym/mcp-runtime   @sym/adapter-slack
      └───────────────┴────────────────┘
                      ↑
                 @sym/agent
```

`packages/*` never import from `apps/*`. Circular dependencies are a CI error.

For the full codemap, architecture invariants, and per-turn latency budget, see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Prerequisites

- **Node.js >= 24** — the repo ships an `.nvmrc`; `nvm use` or `fnm use` picks
  it up automatically.
- **pnpm >= 10** — install via Corepack: `corepack enable && corepack install`.
- **A Slack app** — see [Slack app setup](#slack-app-setup).
- **A Fireworks AI account** — an API key and a model ID from
  [fireworks.ai](https://fireworks.ai). The model must be accessible via the
  OpenAI-compatible chat-completions API.

---

## Quick start

```sh
# 1. Clone and install
git clone https://github.com/amitray007/sym.git
cd sym
pnpm install

# 2. One-time setup (installs Git hooks, checks Node/pnpm versions)
bash scripts/setup.sh

# 3. Copy and fill in the env file
cp .env.example .env
# Edit .env — at minimum: SLACK_* vars + FIREWORKS_API_KEY + FIREWORKS_MODEL

# 4. Build all workspace packages
pnpm build

# 5. Start the agent in watch mode (hot-reloads on file changes)
pnpm --filter @sym/agent dev
```

The agent listens on `http://localhost:3001` (or `$AGENT_PORT`).

To receive Slack events during local development, expose the server with a tunnel
and point your Slack app's Event Subscriptions URL at it:

```sh
ngrok http 3001
# Then set https://<your-tunnel>.ngrok-free.app as the event request URL in
# your Slack app's Event Subscriptions settings.
```

---

## Configuration

Copy `.env.example` to `.env`. Every variable has a comment in that file.

### Required

| Variable                  | Description                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`    | From your Slack app's Basic Information page                        |
| `SLACK_BOT_TOKEN`         | Bot token (`xoxb-…`) from OAuth & Permissions                       |
| `SLACK_BOT_USER_ID`       | Bot's member ID (`U…`) from Slack app settings                      |
| `SLACK_TEAM_ID`           | Your workspace team ID (`T…`)                                       |
| `SYM_OWNER_SLACK_USER_ID` | Slack user ID of the single owner                                   |
| `FIREWORKS_API_KEY`       | API key from [fireworks.ai](https://fireworks.ai)                   |
| `FIREWORKS_MODEL`         | Model ID, e.g. `accounts/fireworks/models/llama-v3p1-405b-instruct` |

### Core (optional)

| Variable                 | Default                                 | Description                                                                        |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `AGENT_PORT`             | `3001`                                  | Port for the Hono HTTP server                                                      |
| `FIREWORKS_BASE_URL`     | `https://api.fireworks.ai/inference/v1` | Override the Fireworks inference endpoint                                          |
| `SLACK_OWNER_USER_TOKEN` | —                                       | Owner's user token (`xoxp-…`); unlocks real workspace search + act-as-owner writes |

### MCP / connectors (optional unless using OAuth connectors)

| Variable                     | Default               | Description                                                                                  |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `SYM_CONFIG_PATH`            | `.sym/config.json`    | Path to the connector config file (written by `sym connector add`)                           |
| `SYM_MCP_SERVERS`            | —                     | Legacy inline JSON connector array (superseded by `SYM_CONFIG_PATH` when the file exists)    |
| `SYM_ENCRYPTION_KEY`         | —                     | 32-byte AES-256-GCM key (base64/hex) for the credential store; required for OAuth connectors |
| `SYM_DB_PATH`                | `.sym/credentials.db` | Path to the encrypted SQLite credential database                                             |
| `SYM_PUBLIC_URL`             | —                     | Public HTTPS base URL of this agent; required for OAuth callbacks                            |
| `SYM_MCP_CONNECT_TIMEOUT_MS` | `10000`               | Max ms to wait for connect + `listTools` on startup per connector                            |

### Operator / CLI (optional)

| Variable            | Default                                     | Description                                                                     |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `SYM_CLI_ALLOWLIST` | `sym,gog,gcloud,gsutil,bq,sentry-cli,gh,jq` | Comma-separated CLIs the agent may execute via `run_cli`; `*` allows any        |
| `SYM_CLI_CONFIRM`   | `false`                                     | Require owner confirmation before `run_cli` executes non-introspection commands |
| `SYM_ADMIN_URL`     | `http://127.0.0.1:<AGENT_PORT>`             | Override the admin HTTP base URL used by the `sym` CLI                          |

### Behavior knobs (optional)

| Variable                   | Default   | Description                                                                                        |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `TASK_CARD_THRESHOLD`      | `1`       | Minimum tool calls before the live task card appears; `0` disables                                 |
| `TASK_CARD_AFTER`          | `delete`  | What happens to the task card after reply: `delete` or `collapse`                                  |
| `OWNER_POST_MARKER`        | `true`    | Append `_(via Sym)_` footer on `post_as_owner` messages                                            |
| `SYM_TURN_DEADLINE_MS`     | `1800000` | Per-turn deadline (ms, 30 min); a stuck model is aborted and returns a partial reply; `0` disables |
| `SYM_THREAD_HISTORY_LIMIT` | `80`      | Max thread history messages per turn; keeps the most-recent N (tail-slice); `0` disables cap       |

### Personas (optional)

| Variable               | Default            | Description                                                                       |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `SYM_PERSONA`          | `sym`              | Home/default voice (`sym`/`operator`/`sensei`/`concierge`/`hype`/`goblin`/`noir`) |
| `SYM_SETTINGS_DB_PATH` | `.sym/settings.db` | Unencrypted SQLite store for per-channel home overrides; put on `/data` in prod   |
| `SYM_PERSONAS_DIR`     | `.sym/personas`    | Directory of editable `<voice>.md` spec overrides; put on `/data` in prod         |

The full reference with one-line descriptions on every variable is also in
[docs/reference/env-vars.md](docs/reference/env-vars.md).

---

## Slack app setup

The canonical source of truth for scopes, events, and features is
`slack/manifest.template.yml`. Render it for your public URL and paste the
output into Slack's app manifest editor:

```sh
SLACK_PUBLIC_BASE_URL=https://your-agent-host.example.com pnpm manifest:render
```

Then in [api.slack.com/apps](https://api.slack.com/apps):

1. **Create a new app** → From an app manifest.
2. **Paste** the rendered YAML output.
3. **Install** the app to your workspace.
4. Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
5. Copy the **Signing Secret** from Basic Information → `SLACK_SIGNING_SECRET`.
6. Find the **Bot User ID** in App Home → `SLACK_BOT_USER_ID`.

> **Use the rendered manifest — do not hand-copy scopes from this README.** The
> manifest template is the authoritative source and is already correct.

The manifest enables:

- `app_mention`, `message.im`, `message.mpim` — message events
- `assistant_thread_started`, `assistant_thread_context_changed` — assistant
  panel lifecycle
- `/sym` slash command
- Interactivity (confirmation buttons, `response_url`)
- `is_mcp_enabled: true` — Slack's native MCP surface

---

## Usage

### Running the agent

```sh
# Development (watch mode, hot-reloads on file changes)
pnpm --filter @sym/agent dev

# Production (built dist)
pnpm --filter @sym/agent start
```

Once running, Sym responds to:

- **DMs** — message the bot directly.
- **@mentions** — `@Sym <your question>` in any channel.
- **Slash command** — `/sym <your question>` from any channel or DM.
- **Assistant panel** — Sym appears in Slack's native AI panel with suggested
  prompts.

### `sym` CLI

The `sym` CLI is the operator control plane. It manages MCP connector wiring and
the encrypted secret store without hand-editing JSON.

```sh
# When installed via the package bin or inside Docker:
sym <command>

# During local development:
pnpm --filter @sym/agent sym <command>
```

#### Interactive menu

```sh
sym           # opens the interactive TUI menu on a terminal
sym menu      # same as bare `sym`
```

The menu has three screens: **Status** (live connector health, `[a]` apply,
`[r]` refresh), **Add connector** (form for stdio/http), and **Secrets**
(list names, add, delete). Exits with an error when stdout is not a TTY — use
flag commands for scripts.

#### Inspect commands

All inspect commands support `--json` for machine-readable output.

| Command                     | Description                                             |
| --------------------------- | ------------------------------------------------------- |
| `sym status`                | Agent reachability, every connector, total tool count   |
| `sym connector ls`          | All connectors (MCP + CLI): health, tools, descriptions |
| `sym connector show <name>` | One connector in full detail                            |
| `sym tools [name]`          | Every tool — MCP tools and CLI connectors               |
| `sym secret ls`             | Stored secret names only (values are never shown)       |
| `sym persona`               | Voices Sym speaks in + the deployment's home voice      |
| `sym persona show <name>`   | One persona: its effective spec + home/customized state |
| `sym persona channels`      | Per-channel home overrides                              |

#### Manage commands

| Command                                        | Description                                                  |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `sym connector add --name N --command C`       | Add an MCP connector (stdio); repeat `--arg` per arg         |
| `sym connector add --name N --url U [--trust]` | Add an MCP connector (HTTP)                                  |
| `sym connector add --spec '<ConnectorConfig>'` | Add an MCP connector (full generic JSON shape)               |
| `sym connector add --cli <bin> --desc "…"`     | Add a CLI connector (allow + describe it for `run_cli`)      |
| `sym connector rm <name>`                      | Remove a connector (MCP or CLI)                              |
| `sym connector trust <name> \| --all`          | Skip confirmation gate for this connector's tools            |
| `sym connector untrust <name> \| --all`        | Re-enable confirmation gate                                  |
| `sym connector reconnect <name>`               | Re-connect one MCP connector against the live pool           |
| `sym apply`                                    | Reconcile the running agent to the config file               |
| `sym secret set <connector> <field>`           | Store a secret (value read from stdin)                       |
| `sym secret rm <connector> <field>`            | Remove a stored secret                                       |
| `sym persona edit <name> \| reset <name>`      | Customize a voice's spec (`.sym/personas/<id>.md`) or revert |
| `sym persona set <ch> <name> \| unset <ch>`    | Home a channel to a voice (overrides `SYM_PERSONA` there)    |

**Secret values are always read from stdin** — never accepted as arguments —
to prevent exposure via the process table:

```sh
printf %s "$MY_TOKEN" | sym secret set sentry SENTRY_AUTH_TOKEN
```

**`NO_COLOR`** — the TUI respects the [`NO_COLOR`](https://no-color.org)
standard: `NO_COLOR=1 sym`.

---

## MCP connectors

Sym's primary extension surface. A connector is anything Sym reaches the outside
world with: an **MCP connector** (structured tools, used via `find_tools` →
`call_tool`) or a **CLI** (used via `run_cli`).

### Connector anatomy

```
Connector = Transport × Auth × Injection
  transport:   stdio (spawn a local binary)  |  http (Streamable HTTP)
  auth:        static (token you provide)  |  oauth  |  ambient (CLI holds its own)
  injection:   env | argv | file | header  (how Sym hands a static secret to the server)
```

### Adding a connector

```sh
# stdio with a static token (e.g. Sentry)
sym connector add --name sentry --command sentry-mcp
printf %s "$SENTRY_AUTH_TOKEN" | sym secret set sentry SENTRY_AUTH_TOKEN

# HTTP connector
sym connector add --name remote --url https://mcp.example.com/mcp

# Apply without a restart
sym apply
```

Or write `.sym/config.json` directly and `sym apply`. A ready-to-copy example
lives in [`examples/config.json`](examples/config.json).

### Auth models

**Model A — Sym holds the credential.** A static token injected via `env` or
`header`, or a service-account key materialized to a tmpfile via `file`
injection, or OAuth tokens in the encrypted credential store.

**Model B — the wrapped CLI holds its own credential (ambient).** Log into the
CLI once (e.g. `gcloud auth login`); it writes creds to its own config directory.
Sym spawns the CLI as an MCP server and injects nothing. Use this when you want
"log in once, no key in Sym".

See [`docs/mcp-setup.md`](docs/mcp-setup.md) for setup guides, a model-selection
decision tree, and a table of Model B edge cases.

### Hot reload

The running agent reconciles the live connector pool without a restart:

```sh
sym apply
# or directly: curl -s -X POST http://127.0.0.1:3001/admin/reload | jq
```

Reconcile is validate-then-swap: a connector that fails to connect leaves the
previously-healthy one serving; unchanged connectors are untouched; dropped ones
are closed.

---

## Development

### Scripts

| Script                  | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `pnpm build`            | Build all packages (Turbo)                                       |
| `pnpm dev`              | Start all packages in watch mode (Turbo)                         |
| `pnpm test`             | Run unit tests across all packages (Vitest)                      |
| `pnpm test:integration` | Run real-wire integration tests (MCP + HTTP; no Slack required)  |
| `pnpm test:coverage`    | Unit tests with v8 coverage                                      |
| `pnpm typecheck`        | Type-check every package with tsc                                |
| `pnpm lint`             | ESLint + Prettier check                                          |
| `pnpm lint:fix`         | ESLint autofix + Prettier write                                  |
| `pnpm format`           | Prettier write across the repo                                   |
| `pnpm depcruise`        | Dependency graph analysis (enforces the DAG; informational only) |
| `pnpm knip`             | Dead code analysis (informational only)                          |
| `pnpm manifest:render`  | Render the Slack app manifest template to stdout                 |
| `pnpm clean`            | Remove all build artifacts and `node_modules`                    |

**Full gate before pushing:**

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build
```

### Testing approach

- Unit tests live in `tests/` inside each package (e.g. `apps/agent/tests/`,
  `packages/kernel/tests/`), not co-located with source.
- Integration tests are real-wire (no mocks) and also live in `tests/`. They
  spin up ephemeral in-process servers; no external services are required.
- Every test file imports from `vitest` explicitly (`globals: false`).

### Project structure

```
sym/
  apps/
    agent/              The single deployable (Hono server + Pi loop + sym CLI)
      src/
        server.ts       HTTP entry point; all Slack + admin routes
        handle-turn.ts  Pi loop entry point (every message passes through here)
        tools/          Built-in tool families (slack-read/write/search/users,
                        web, planning, presentation, time)
        mcp/            MCP connector pool, reconcile, credential store
        pi/             Pi agent loop (loop, meta-tools, model, think-router)
        cli/            `sym` operator CLI (commands + interactive TUI)
        config.ts       AgentConfig — reads all env vars
  packages/
    contracts/          @sym/contracts — shared types (zero runtime code)
    kernel/             @sym/kernel — prompt assembly, receipt, tool registry
    mcp-runtime/        @sym/mcp-runtime — connector runtime (reusable)
    adapter/
      slack/            @sym/adapter-slack — Slack API client + Block Kit renderer
  slack/
    manifest.template.yml  Canonical Slack app manifest
  examples/             Sample connector config.json + setup walkthrough
  docs/                 Reference docs (env vars, MCP setup, architecture notes)
  Dockerfile            Production image (node:24-slim, /data volume)
  docker-compose.yml    Single-service local run (agent + sym_data volume)
```

---

## Deployment

### Docker

```sh
# Build
docker build -t sym-agent .

# Run — mount a persistent volume for CLIs, auth state, and the credential store
docker run -d \
  --name sym \
  --env-file .env \
  -p 3001:3001 \
  -v sym-data:/data \
  sym-agent
```

The `/data` volume persists across redeploys. The image is deliberately
**CLI-agnostic** — it bakes in only generic runtimes (Node, Python 3, uv/uvx,
curl, git). Actual tool binaries (gcloud, sentry-cli, MCP server packages) are
installed onto `/data/bin` once via `docker exec` and survive every redeploy
because the volume persists. `HOME` is set to `/data/home` so every CLI's login
credentials also persist tool-agnostically.

The `sym` CLI is baked into the image:

```sh
docker exec sym sym status
docker exec -it sym sym menu    # interactive TUI (needs -it)
```

The image exposes a `/health` endpoint: `GET /health` returns `{"ok":true}`.

### docker-compose

A `docker-compose.yml` is included in the repo root for local single-command
runs. It defines one stateless `agent` service (the Slack thread is the
conversation memory) with a `sym_data` volume for the only durable state — the
credential store and any ambient CLI config:

```sh
docker compose up --build      # build + run the agent
docker compose logs -f agent   # follow logs
```

### Dokploy

A `dokploy/` directory contains deployment config and an env template for
[Dokploy](https://dokploy.com)-based deploys. See `dokploy/` for details.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, commit
conventions, cross-unit impact checklist, and pull request process.

For questions, open a [GitHub Discussion](https://github.com/amitray007/sym/discussions).
For bugs, use the [Bug Report issue template](https://github.com/amitray007/sym/issues/new?template=bug_report.yml).

---

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).
You may use, run, study, and modify Sym for any **noncommercial** purpose.
**Commercial use, selling, or commercial redistribution requires a separate
license** — contact Amit Ray at hey@amitray.dev.

This is _not_ an OSI-approved open-source license.

---

## Acknowledgements

- **[Pi agent runtime](https://github.com/earendil-works/pi)** (`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`) — the agent loop Sym runs on.
- **[Model Context Protocol](https://modelcontextprotocol.io)** (`@modelcontextprotocol/sdk`) — the extension protocol that powers Sym's connector surface.
- **[Hono](https://hono.dev)** — the lightweight HTTP server framework.
- **[Fireworks AI](https://fireworks.ai)** — the LLM inference provider.
