# Environment variables

Sym is configured entirely through environment variables. Copy `.env.example` to
`.env` and fill in the values — that file carries a one-line comment on every
variable. This page is the canonical reference, grouped by concern.

## Core (required)

| Variable                  | Description                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`    | From your Slack app's Basic Information page                        |
| `SLACK_BOT_TOKEN`         | Bot token (xoxb-…) from OAuth & Permissions                         |
| `SLACK_BOT_USER_ID`       | Bot's member ID (U…) from Slack app settings                        |
| `SLACK_TEAM_ID`           | Your workspace team ID (T…)                                         |
| `SYM_OWNER_SLACK_USER_ID` | Slack user ID of the single owner                                   |
| `FIREWORKS_API_KEY`       | API key from fireworks.ai                                           |
| `FIREWORKS_MODEL`         | Model ID, e.g. `accounts/fireworks/models/llama-v3p1-405b-instruct` |

## Core (optional)

| Variable                 | Default                                 | Description                                                               |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| `FIREWORKS_BASE_URL`     | `https://api.fireworks.ai/inference/v1` | Override the Fireworks inference endpoint                                 |
| `AGENT_PORT`             | `3001`                                  | Port for the Hono server                                                  |
| `SLACK_OWNER_USER_TOKEN` | —                                       | Owner's user token (xoxp-…); unlocks real workspace search + act-as-owner |

## MCP / connectors (optional unless using OAuth connectors)

| Variable                     | Default               | Description                                                                                  |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `SYM_CONFIG_PATH`            | `.sym/config.json`    | Path to the connector config file (written by `sym add`)                                     |
| `SYM_MCP_SERVERS`            | —                     | Legacy inline JSON connector array (superseded by `SYM_CONFIG_PATH`)                         |
| `SYM_ENCRYPTION_KEY`         | —                     | 32-byte AES-256-GCM key (base64/hex) for the credential store; required for OAuth connectors |
| `SYM_DB_PATH`                | `.sym/credentials.db` | Path to the encrypted SQLite credential database                                             |
| `SYM_PUBLIC_URL`             | —                     | Public HTTPS base URL of this agent; required for OAuth callbacks                            |
| `SYM_MCP_CONNECT_TIMEOUT_MS` | `10000`               | Max ms to wait for connect + listTools on startup per connector                              |

## Operator / CLI (optional)

| Variable            | Default                                     | Description                                                                     |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `SYM_CLI_ALLOWLIST` | `sym,gog,gcloud,gsutil,bq,sentry-cli,gh,jq` | Comma-separated CLIs the agent may execute; `*` allows any                      |
| `SYM_CLI_CONFIRM`   | `false`                                     | Require owner confirmation before `run_cli` executes non-introspection commands |
| `SYM_ADMIN_URL`     | `http://127.0.0.1:<AGENT_PORT>`             | Override the admin HTTP base URL used by the `sym` CLI                          |

## Behavior knobs (optional)

| Variable                   | Default   | Description                                                                                        |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `TASK_CARD_THRESHOLD`      | `1`       | Minimum tool calls before the live task card appears; `0` disables                                 |
| `TASK_CARD_AFTER`          | `delete`  | What happens to the task card after reply: `delete` or `collapse`                                  |
| `OWNER_POST_MARKER`        | `true`    | Append `_(via Sym)_` footer on `post_as_owner` messages                                            |
| `SYM_TURN_DEADLINE_MS`     | `1800000` | Per-turn deadline (ms, 30 min); a stuck model is aborted and returns a partial reply. `0` disables |
| `SYM_THREAD_HISTORY_LIMIT` | `80`      | Max threaded history messages per turn; keeps the most-recent N (tail-slice). `0` disables cap     |

## Personas (optional)

| Variable               | Default            | Description                                                                                                                   |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `SYM_PERSONA`          | `sym`              | Home/default voice: `sym`, `operator`, `sensei`, `concierge`, `hype`, `goblin`, `noir` (case-insensitive; unknown → `sym`)    |
| `SYM_SETTINGS_DB_PATH` | `.sym/settings.db` | Unencrypted SQLite store for per-channel home overrides (`sym persona set`). Put on `/data` in production (survives redeploy) |
| `SYM_PERSONAS_DIR`     | `.sym/personas`    | Directory of editable `<voice>.md` spec overrides. Put on `/data` in production                                               |

## Observability (optional)

Sym instruments its model calls with OpenTelemetry (`@opentelemetry/api`, the
`gen_ai.*` conventions) — **no-op by default**, zero overhead unless you register
an SDK. To collect traces, run the agent under a standard OTel SDK pointed at a
collector:

```sh
npm i @opentelemetry/auto-instrumentations-node
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
OTEL_SERVICE_NAME=sym \
node --import @opentelemetry/auto-instrumentations-node/register dist/index.js
```

The inbound Slack request is auto-traced; Sym's `gen_ai.chat` span nests beneath
it with the model id, reasoning effort, and token usage. The `OTEL_*` variables
are read by the OpenTelemetry SDK, not Sym directly.
