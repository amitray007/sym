# Self-hosting

Sym runs as one Docker service with Postgres. Any Docker host works. The reference deployment uses
[Dokploy](https://dokploy.com) with a [Tailscale](https://tailscale.com) sidecar.

## Network

| Route | Exposure | Why |
|---|---|---|
| `/eve/v1/slack` | Public HTTPS | Slack sends events, interactivity, and slash commands. Eve has no Socket Mode |
| `/.well-known/workflow/` | Public HTTPS, unrewritten | Workflow webhooks, including worker callback URLs |
| `/eve/v1/mcp`, `/eve/v1/session` | Private network only | Workers and scripts call Sym |
| Worker MCP (T3 `/mcp`) | Private network only | Sym calls the worker |

- Allow only the public paths at the proxy. Block everything else from the internet.
- The callback URL that a worker POSTs to must resolve from the worker host. Off Vercel, Eve
  builds webhook URLs as `localhost:3000`, so set `SYM_CALLBACK_URL` (decision 028).
- The Eve container joins the private network through a sidecar, so it can reach the worker.

Reference choice: Dokploy's public Traefik domain with a path allow-list (decision 006).
Tailscale Funnel limited to the Slack path also works.

## Credentials

| Variable | Source |
|---|---|
| `SLACK_BOT_TOKEN` | Slack app, Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Slack app, Basic Information |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway, for the brain model |
| `SYM_MODEL` | Gateway model ID, for example `anthropic/claude-sonnet-5.5`. Optional |
| `SYM_REASONING` | Optional. Replaces the reasoning level of the brain and its subagents: `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Set `provider-default` for a model without reasoning, because some providers reject any level for it (decision 064). An unknown value warns and is ignored |
| `SYM_WORKER_MODEL` | Optional. Overrides the default worker model, as `<provider>/<model>`, for example `codex/gpt-6-luna`. It joins the model list when missing (decision 041) |
| `DATABASE_URL` | Postgres. `compose.yaml` builds it from `POSTGRES_PASSWORD` |
| `SYM_PACK_DIR` | Path to the mounted pack |
| `SYM_MCP_TOKEN` | Optional shared bearer for status reads at `/eve/v1/mcp`. It cannot post worker progress or questions. New jobs receive separate scoped credentials from the ledger (decision 065). Keep the route private |
| `SYM_API_TOKEN` | Bearer for scripts, CI, and operators calling `/eve/v1/session`. Unset means production rejects them (decision 019) |
| `SYM_PERSONA` | Optional. The default voice: `plain`, `casual` (default), or `spicy` (decisions 044, 046). An unknown value warns and uses `casual`. The owner's `/sym persona` setting wins over it, and a pack `persona` file wins over both |
| `SYM_PROJECTS` | T3 project titles or IDs Sym may work on, comma-separated. Required without a pack: with neither, no job starts (decision 042). Ignored when a pack lists `projects` |
| `SYM_WORKER_LABEL` | Optional. The name Slack users see for the worker, such as `Builder`. Default `Worker`. Max 30 characters (decision 044) |
| `SYM_FEEDBACK` | Optional. `on` (default) or `off` (also `false`, `0`, `no`). Off removes the helpful / not helpful buttons from replies. Old buttons still record clicks (decision 047) |
| `SYM_DIGEST_CHANNEL` | Optional. The daily digest's channel ID, or the owner's user ID for a DM. Unset means no digest and no weekly `learn` proposals. A pack's `channels.digest` wins (decision 024) |
| `SYM_DIGEST_CRON` | Optional. When the digest posts, as cron in UTC. Default `0 17 * * *`. Read at build time, so a change needs a rebuild |
| `SYM_DIGEST` | Optional. `off` (default) or `on` (also `true`, `1`, `yes`). On posts the daily digest to the digest channel. The `learn` proposals and the sign-in notice use the channel either way (decision 054) |
| `SYM_CODE_CHANNELS` | Optional. `off` (default) or `on`. On moves each job a person starts into its own Slack code channel; a Slack refusal keeps it in its thread. Reinstall the app with the current manifest first (decision 067) |
| `SYM_VERIFIER` | Optional. `off` (default) or `on`. On runs the `verifier` subagent, a paid model call, on each finished code job. Off ends the job with the rule checks alone (decision 054) |
| `SYM_RESULT_WRITER` | Optional. `on` (default) or `off`. On runs the `writer` subagent, a model call, on each finished code job, so the result reads in the persona's voice. Off keeps the template result (decision 062) |
| `SYM_PR_FOLLOW` | Optional. `off` (default) or `on`. On asks the worker to watch each job's PR for 7 days and posts CI and review wakes in the job thread (decision 054) |
| `SYM_SLACK_USERS` | Slack user IDs allowed to use Sym, comma-separated |
| `SYM_CALLBACK_URL` | Base URL a worker uses to call Sym back, such as Sym's private-network address. Without it, jobs wait for the 4-minute poll (decision 028) |
| `SYM_SIGNIN_URL` | Base URL the owner's browser returns to after the worker sign-in, such as Sym's public HTTPS address. Must be https unless it is loopback. Defaults to `SYM_CALLBACK_URL` (decision 036) |
| `SYM_OWNER_SLACK_USER` | The owner's Slack user ID when there is no pack. Only the owner can sign Sym in to the worker |
| `SYM_MCP_<NAME>_TOKEN` | Bearer token for an MCP connection that needs one, such as `SYM_MCP_EXAMPLE_TRACKER_TOKEN` for `example-tracker`. Sym tells the owner the exact name when the owner connects the server. Sym reads only variables named `SYM_MCP_*_TOKEN` (decision 045) |
| `T3_MCP_URL` | Worker MCP URL when the pack has no `workers` entry |
| `T3_TOKEN`, `T3_TOKEN_EXPIRES_AT` | Fallback worker token and its expiry, from `pnpm t3:login`. Sym uses them only when Postgres holds no sign-in for the worker |

OAuth sign-ins for MCP connections are not environment variables either. The owner asks Sym to
connect a server, Sym sends the sign-in link to the owner's DM, and Sym stores the token and any
refresh token in Postgres. `SYM_SIGNIN_URL` serves both sign-ins (decision 045).

The worker sign-in token is not an environment variable. The owner asks Sym in Slack to sign in
to the worker, approves on T3's page, and Sym stores the token in Postgres (decision 036). A T3
sign-in lasts 30 days, and Sym warns 5 days before it ends.

Keep secrets in the deployment's environment or secret store. Never commit them, and never put
them in the pack.

## Deploy

[`compose.yaml`](../compose.yaml) is the reference deployment and the local lab in one file
(decision 040). `docker compose up` builds the image (decision 019) and runs three services: Sym,
Postgres 18, and a Tailscale sidecar that Sym shares its network with. `pnpm db:up` starts only
Postgres.

1. Create a Docker Compose app in Dokploy from this repository. The compose path is the default,
   `./compose.yaml`.
2. In the Environment tab, set the variables in [Credentials](#credentials), plus:
   - `POSTGRES_PASSWORD`: a URL-safe value, such as `openssl rand -hex 32`. The compose file
     builds `DATABASE_URL` from it, so do not set `DATABASE_URL`.
   - `TS_AUTHKEY`: a Tailscale auth key for the sidecar. `TS_HOSTNAME` is optional (`sym`).
3. Add the public routes as Dokploy domains on the `tailscale` service, port 3000, one per path:
   `/eve/v1/slack` and `/.well-known/workflow`. Do not strip the path. Sym listens in the
   sidecar's network, so the domains point at the sidecar.
4. Deploy. The start command applies ledger migrations, then runs `eve start`, which also runs
   the scheduler. Volumes keep Postgres, the workflow state (`/app/.eve/.workflow-data`), and the
   Tailscale node identity.
5. The sidecar publishes all of Sym on the tailnet at `https://<TS_HOSTNAME>.<tailnet>.ts.net`.
   Use that address for `SYM_CALLBACK_URL`, the worker MCP channel, and `/eve/v1/session`.
6. Check from inside the `sym` container that the worker's MagicDNS name resolves, for example
   `getent hosts <worker>.<tailnet>.ts.net`. MagicDNS must be on for the tailnet.

Rules for any host:

- Run exactly one Sym replica. Schedules and leases assume one scheduler.
- Pass `/eve/` and `/.well-known/workflow/` unrewritten.
- Use a Postgres with backups. In Dokploy, back up the `postgres` named volume.
- Pin the Eve version. Upgrade only when no jobs run, because an upgrade strands running
  sessions. Reconcile re-attaches jobs after a restart.

## Worker host (T3 Code)

1. Run the T3 server reachable on the private network, for example
   `t3 serve --tailscale-serve`, or enable Tailscale HTTPS in the T3 app (Settings, Connections).
   Sym needs HTTPS for the sign-in: its MCP client sends tokens over plain HTTP only to loopback.
   If the worker host also serves Sym's public Slack route through Tailscale Funnel, put the
   Funnel on its own port (8443 or 10000). Funnel exposes a whole HTTPS port, so a Funnel on 443
   would also expose T3.
2. Copy the MCP URL from T3 Settings, Connections, into the pack's `workers` entry.
3. Set `SYM_SIGNIN_URL` to Sym's public HTTPS base, the one that serves `/.well-known/workflow/`.
   Start Sym, then tell it "sign in to the worker" in a DM. Sym registers as an OAuth client and
   sends you the T3 link in a DM. Until then, reconcile logs a warning and leaves jobs alone.
4. Open the link within 10 minutes, approve the sign-in on the T3 page, and pick the access
   level (Auto by default, decision 009). The browser returns to Sym, and Sym confirms in Slack.
5. Keep the host awake and logged in. The macOS T3 service stops at logout. The Linux service
   survives it.

## Owner actions

Only a person can do these:

- Create and install the Slack app from [`slack/manifest.yaml`](../slack/manifest.yaml). After a
  manifest change (such as the Home tab), import it again and reinstall the app.
- Choose and configure the public route.
- Approve the worker sign-in and pick its access level, then re-approve every 30 days. Ask Sym
  to sign in to the worker for a new link.
- Approve permission prompts on the worker when a thread blocks.
- Set `SYM_MCP_<NAME>_TOKEN` and redeploy when Sym says an MCP connection needs a token, or
  approve the sign-in link Sym sends for an OAuth connection.
