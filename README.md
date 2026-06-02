# Sym

A personal AI teammate that lives in your Slack workspace. Send it a DM or
@mention it in a channel and it replies. No message database and no _web_
dashboard — the Slack thread is its memory. (Sym does ship a small operator
TUI/CLI and an encrypted local credential store as a deliberate control tier for
MCP connectors — see [docs/FUTURE.md](docs/FUTURE.md).)

**Stack:** Hono (HTTP server) · Pi agent SDK · Fireworks (OpenAI-compatible LLM) · Slack Events API

## How it works

1. Slack sends a signed HTTP event to `apps/agent` (Hono).
2. The server verifies the Slack signing secret and drops anything not from the
   configured workspace.
3. Only the owner (`SYM_OWNER_SLACK_USER_ID`) can invoke the bot — all other
   messages are silently ignored.
4. The full Slack thread is fetched and passed to the Pi agent loop as context
   (the thread _is_ the memory — stateless, no DB).
5. The Pi loop calls Fireworks (OpenAI-compatible) with a set of built-in
   read-only tools and streams the reply back into the thread.

## Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable                  | Required | Description                                                                    |
| ------------------------- | -------- | ------------------------------------------------------------------------------ |
| `SLACK_SIGNING_SECRET`    | yes      | From your Slack app's Basic Information page                                   |
| `SLACK_BOT_TOKEN`         | yes      | Bot token (xoxb-…) from OAuth & Permissions                                    |
| `SLACK_BOT_USER_ID`       | yes      | Bot's member ID (U…) from Slack app settings                                   |
| `SLACK_TEAM_ID`           | yes      | Your workspace team ID (T…)                                                    |
| `SYM_OWNER_SLACK_USER_ID` | yes      | Slack user ID of the single owner                                              |
| `FIREWORKS_API_KEY`       | yes      | API key from fireworks.ai                                                      |
| `FIREWORKS_MODEL`         | yes      | Model ID, e.g. `accounts/fireworks/models/llama-v3p1-405b-instruct`            |
| `FIREWORKS_BASE_URL`      | no       | Override Fireworks base URL (default: `https://api.fireworks.ai/inference/v1`) |
| `AGENT_PORT`              | no       | Port for the Hono server (default: `3001`)                                     |

## Setup

### 1. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
   **from scratch**.
2. Under **OAuth & Permissions**, add these bot token scopes:
   - `app_mentions:read`, `channels:history`, `channels:read`
   - `chat:write`, `groups:history`, `im:history`, `im:write`
   - `mpim:history`, `users:read`
3. Install the app to your workspace and copy the **Bot User OAuth Token**.
4. Under **Event Subscriptions**, enable events and set the request URL to
   `https://<your-agent-host>/slack/events`.
5. Subscribe to these bot events: `app_mention`, `message.im`.
6. Copy the **Signing Secret** from Basic Information.
7. Find your **Bot User ID** (the `SLACK_BOT_USER_ID`) in the app's settings
   under "App Home" → "Your App's Bot User".

### 2. Configure env

```sh
cp .env.example .env
# edit .env — fill in all required variables
```

### 3. Run

```sh
pnpm install
pnpm --filter @sym/agent dev
```

The agent listens on `http://localhost:3001` (or `$AGENT_PORT`).

To expose it to Slack during local development, use a tunnel such as
`ngrok http 3001` and point the Slack app's Event Subscriptions URL at the
tunnel URL.

## Repository layout

```
apps/
  agent/    Hono server — Slack events → Pi agent loop → Fireworks reply
docs/
  FUTURE.md Parked features (connectors, skills, DB, dashboard, audit, tasks)
```

## License

MIT. Private OSS / internal use; not published to public npm. See `LICENSE`.
