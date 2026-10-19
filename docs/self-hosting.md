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
| `ANTHROPIC_API_KEY` | Model provider |
| `DATABASE_URL` | Postgres |
| `SYM_PACK_DIR` | Path to the mounted pack |
| `SYM_MCP_TOKEN` | Bearer for workers calling Sym's MCP channel |

The worker sign-in token is not an environment variable. Sym stores it in Postgres after the owner
approves the OAuth sign-in. A T3 sign-in lasts 30 days, and Sym warns 5 days before it ends.

Keep secrets in the deployment's environment or secret store. Never commit them, and never put
them in the pack.

## Deploy

1. Build with `eve build`. Run with `eve start`, which also runs the scheduler.
2. Run exactly one replica. Schedules and leases assume one scheduler.
3. Mount a volume at `.eve/.workflow-data`.
4. Point the proxy at the service. Pass `/eve/` and `/.well-known/workflow/` unrewritten.
5. Use a Postgres with backups.
6. Pin the Eve version. Upgrade only when no jobs run, because an upgrade strands running
   sessions. Reconcile re-attaches jobs after a restart.

## Worker host (T3 Code)

1. Run the T3 server reachable on the private network, for example
   `t3 serve --tailscale-serve`.
2. Copy the MCP URL from T3 Settings, Connections, into the pack's `workers` entry.
3. Start Sym. It registers as an OAuth client and posts a private sign-in prompt to the owner.
4. Approve the sign-in on the T3 page and pick the access level (Auto by default, decision 009).
5. Keep the host awake and logged in. The macOS T3 service stops at logout. The Linux service
   survives it.

## Owner actions

Only a person can do these:

- Create and install the Slack app from [`slack/manifest.yaml`](../slack/manifest.yaml).
- Choose and configure the public route.
- Approve the worker sign-in and pick its access level, then re-approve every 30 days.
- Approve permission prompts on the worker when a thread blocks.
