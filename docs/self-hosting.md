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
- The callback URL that a worker POSTs to must resolve from the worker host. Milestone 1 checks
  whether `createWebhook` returns the public or the private host.
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
| `SYM_WORKER_MODEL` | Worker thread model as `<provider>/<model>`, for example `codex/gpt-6-luna`. Needed when a worker project has no default model |
| `DATABASE_URL` | Postgres |
| `SYM_PACK_DIR` | Path to the mounted pack |
| `SYM_MCP_TOKEN` | Bearer for worker threads calling `/eve/v1/mcp`. Unset means the channel rejects every request. Keep it on the private network (decision 027) |
| `SYM_API_TOKEN` | Bearer for scripts, CI, and operators calling `/eve/v1/session`. Unset means production rejects them (decision 019) |
| `SYM_SLACK_USERS` | Slack user IDs allowed to use Sym, comma-separated |
| `SYM_CALLBACK_URL` | Base URL a worker uses to call Sym back, such as Sym's private-network address. Without it, jobs wait for the 4-minute poll (decision 028) |
| `SYM_SIGNIN_URL` | Base URL the owner's browser returns to after the worker sign-in, such as Sym's public HTTPS address. Must be https unless it is loopback. Defaults to `SYM_CALLBACK_URL` (decision 036) |
| `SYM_OWNER_SLACK_USER` | The owner's Slack user ID when there is no pack. Only the owner can sign Sym in to the worker |
| `T3_MCP_URL` | Worker MCP URL when the pack has no `workers` entry |
| `T3_TOKEN`, `T3_TOKEN_EXPIRES_AT` | Fallback worker token and its expiry, from `pnpm t3:login`. Sym uses them only when Postgres holds no sign-in for the worker |

The worker sign-in token is not an environment variable. The owner asks Sym in Slack to sign in
to the worker, approves on T3's page, and Sym stores the token in Postgres (decision 036). A T3
sign-in lasts 30 days, and Sym warns 5 days before it ends.

Keep secrets in the deployment's environment or secret store. Never commit them, and never put
them in the pack.

## Deploy

1. Build the image with `docker build -t sym .` (decision 019). Its start command applies ledger
   migrations, then runs `eve start`, which also runs the scheduler. The container listens on
   port 3000.
2. Run exactly one replica. Schedules and leases assume one scheduler.
3. Mount a volume at `/app/.eve/.workflow-data`.
4. Point the proxy at the service. Pass `/eve/` and `/.well-known/workflow/` unrewritten.
5. Use a Postgres with backups.
6. Pin the Eve version. Upgrade only when no jobs run, because an upgrade strands running
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

- Create and install the Slack app from [`slack/manifest.yaml`](../slack/manifest.yaml).
- Choose and configure the public route.
- Approve the worker sign-in and pick its access level, then re-approve every 30 days. Ask Sym
  to sign in to the worker for a new link.
- Approve permission prompts on the worker when a thread blocks.
