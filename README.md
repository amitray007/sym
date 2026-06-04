# Sym

A personal AI teammate that lives in your Slack workspace — DM it, @mention it,
or use `/sym <prompt>` from any channel. No web dashboard, no message database.

[![CI](https://github.com/amitray007/sym/actions/workflows/ci.yml/badge.svg)](https://github.com/amitray007/sym/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

---

## What is Sym

Sym is a single-tenant, single-deployable Slack bot built on a **two-tier model**:

**Conversational tier** — completely stateless. The Slack thread is the memory.
A signed Slack event arrives, passes an owner gate, the full thread history is
fetched as context, the Pi agent loop calls a Fireworks-hosted LLM, and the
reply streams back into the thread. No database, no sessions, no state.

**Control tier** — intentional local state. A `sym` CLI — with a simple
interactive menu — lets you manage MCP connectors and their OAuth tokens,
stored in an AES-256-GCM-encrypted SQLite credential database. This is
Sym's primary extension surface: wire in any MCP server and its tools become
available to the agent in every conversation.

## How it works

1. Slack sends a signed HTTP event to the Hono server at `/slack/events`.
2. The server verifies the signing secret and drops events from other workspaces.
3. The owner gate (`SYM_OWNER_SLACK_USER_ID`) silently ignores non-owner messages.
4. The full thread is fetched and passed to `handleTurn`, the Pi loop's sole entry point.
5. Pi calls Fireworks with built-in tools (Slack reads/writes, web fetch, CLI
   execution, planning) and on-demand MCP connector tools.
6. The reply streams back via Slack's streaming API, with a live task card that
   tracks tool calls in real time.

**Additional surfaces:**

- `/sym <prompt>` — slash command that answers from any channel or DM.
- Assistant panel — Sym appears in Slack's native AI panel with suggested prompts.
- Confirmation buttons — destructive tools (and `run_cli` when `SYM_CLI_CONFIRM`
  is set) pause for owner approval before executing.
- `/admin/*` — loopback-only HTTP surface for the `sym` CLI to hot-reload
  connectors without restarting the agent.

## Repository layout

```
sym/
  apps/
    agent/          Main Hono server — the single deployable
      src/
        server.ts             HTTP entrypoint; routes /slack/* + /admin/*
        event-router.ts       Processes events, slash commands, interactivity
        handle-turn.ts        Per-turn orchestrator (Pi loop entry point)
        turn-context.ts       Thread history loader + viewed-channel resolver
        stream-reply.ts       Streaming delivery helpers
        task-card-manager.ts  Live task-card state machine
        owner-gate.ts         Single-owner access control
        slack-guard.ts        LLM relevance + injection guard (fail-open)
        confirmations.ts      Destructive-tool confirm/cancel registry
        assistant.ts          Assistant panel lifecycle (setTitle, prompts)
        builtin-tools.ts      Built-in tool wiring (delegates to tools/)
        tools/                One file per tool family + shared helpers
        pi/                   Pi agent loop (loop.ts, meta-tools, model, think-router)
        mcp/                  MCP connector pool, reconcile, introspect, OAuth store
        cli/                  `sym` operator CLI (status, connector, apply, secret)
        tui/                  Ink/React operator dashboard (Dashboard, SecretsManager, …)
        config.ts             AgentConfig — reads all env vars
        workspace-context.ts  Boot-time Slack workspace bootstrap
  packages/
    contracts/      @sym/contracts — shared TypeScript types (domain models,
                    tool interfaces, render primitives, Slack types)
    kernel/         @sym/kernel — prompt assembly, receipt formatting, tool registry
    adapter/
      slack/        @sym/adapter-slack — Slack Web API client, Block Kit rendering,
                    event normalisation, signature verification, thread fetching
  slack/
    manifest.template.yml   Canonical Slack app manifest (scopes, events, features)
    README.md               Slack app setup guide
  dokploy/          Dokploy deployment config + env template
  scripts/          render-manifest.js + setup.sh
  assets/           Bot avatar images
  examples/         Sample connector config.json + setup walkthrough (examples/README.md)
  docs/             Internal docs (refactor audit, mcp-setup, dependency graph)
  Dockerfile        Production image (node:24-slim, /data volume for CLIs + auth)
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values. See `.env.example` for
one-line comments on every variable.

**Required at minimum:** `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
`SLACK_BOT_USER_ID`, `SLACK_TEAM_ID`, `SYM_OWNER_SLACK_USER_ID`,
`FIREWORKS_API_KEY`, `FIREWORKS_MODEL`.

Connectors, the operator CLI, and behavior knobs are all optional. The full,
grouped reference — every variable, its default, and what it does — lives in
**[docs/reference/env-vars.md](docs/reference/env-vars.md)**.

## Quick start

### Local development

```sh
# 1. Install dependencies
pnpm install

# 2. One-time setup (installs git hooks and checks Node/pnpm versions)
bash scripts/setup.sh

# 3. Copy and fill in the env file
cp .env.example .env
# edit .env — fill in the required variables (Slack + Fireworks at minimum)

# 4. Start the agent (hot-reloads on file changes)
pnpm --filter @sym/agent dev
```

The agent listens on `http://localhost:3001` (or `$AGENT_PORT`).

To receive Slack events during local development, expose the server with a
tunnel and point the Slack app's Event Subscriptions URL at it:

```sh
ngrok http 3001
# Set https://<your-tunnel-id>.ngrok-free.app as the event request URL
```

### Docker

```sh
# Build the image
docker build -t sym-agent .

# Run — mount a persistent volume for CLIs, auth state, and the credential store
docker run -d \
  --name sym \
  --env-file .env \
  -p 3001:3001 \
  -v sym-data:/data \
  sym-agent
```

The `/data` volume persists across redeploys:
CLI auth (`gcloud`, `gh`, etc.), MCP server packages, and the OAuth credential
store (`/data/credentials.db`). See the Dockerfile for details.

## Slack app setup

The canonical source of truth for scopes, events, and features is
`slack/manifest.template.yml`. Render it and paste the output into Slack's
app manifest editor:

```sh
# Set SLACK_PUBLIC_BASE_URL to your public HTTPS URL first
SLACK_PUBLIC_BASE_URL=https://your-agent-host.example.com pnpm manifest:render
```

Then in [api.slack.com/apps](https://api.slack.com/apps):

1. Create a new app → **From an app manifest**.
2. Paste the rendered YAML output.
3. Install the app to your workspace.
4. Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
5. Copy the **Signing Secret** from Basic Information → `SLACK_SIGNING_SECRET`.
6. Note the **Bot User ID** from App Home → `SLACK_BOT_USER_ID`.

> **Do not hand-copy scopes from this README** — the manifest template is the
> source of truth and is already correct. Past README prose had wrong scopes
> (`im:write` instead of `im:read`; missing `commands`, `assistant:write`).

## Operator control tier

Run `sym` (or `sym menu`) in a terminal to open the interactive connector
dashboard. This is separate from the conversational tier — it manages MCP
connector configuration and OAuth tokens stored in the encrypted credential
store.

```sh
# Interactive TUI dashboard
sym

# CLI commands (machine-readable, safe for scripts)
sym status --json            # show agent + connector health
sym connector list           # list configured connectors
sym apply                    # hot-reload connector config without restart
sym secret set <name>        # add/rotate a stored secret (reads from stdin)
```

**NO_COLOR** — the TUI honours the [`NO_COLOR`](https://no-color.org) standard:

```sh
NO_COLOR=1 sym
```

**Non-TTY / pipe safety** — `sym menu` and `sym tui` exit with an error when
stdout is not a TTY. Use `sym status --json` for machine-readable output in
scripts or from the agent's `run_cli`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commit conventions, and
the pull request process.

## License

MIT. See [LICENSE](LICENSE).
