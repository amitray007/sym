# Self-hosting

Sym runs as one Docker service with Postgres. Any Docker host works. The reference deployment uses
[Dokploy](https://dokploy.com) with a [Tailscale](https://tailscale.com) sidecar.

## Network

| Route | Exposure | Why |
|---|---|---|
| `/eve/v1/slack` | Public HTTPS | Slack sends events, interactivity, and slash commands. Eve has no Socket Mode |
| `/.well-known/workflow/` | Public HTTPS, unrewritten | Workflow webhooks, including worker callback URLs |
| `/sym/hooks/`, `/sym/reveal/` | Public HTTPS, only with `SYM_WEBHOOK_KEY` set | Webhook triggers: other systems POST signed requests, and creators see a secret once (decision 090) |
| `/eve/v1/github`, `/eve/v1/linear` | Public HTTPS, only when that app is set up | GitHub App and Linear app webhooks (decision 091) |
| `/eve/v1/mcp`, `/eve/v1/session` | Private network only | Workers and scripts call Sym |
| Worker MCP (T3 `/mcp`) | Private network only | Sym calls the worker |

- Allow only the public paths at the proxy. Block everything else from the internet.
- Sandbox containers, when on, have no network by default and never join Sym's network or the
  tailnet ([Sandbox](#sandbox)).
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
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway, for the brain model. Not needed with a direct provider |
| `SYM_MODEL_PROVIDER` | Optional. `gateway` (default), `anthropic`, or `openai`. A direct provider calls the provider with its own key and skips the gateway (decision 080). An unknown value warns and uses `gateway` |
| `ANTHROPIC_API_KEY` | Anthropic API key, for `SYM_MODEL_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | OpenAI API key, for `SYM_MODEL_PROVIDER=openai`. Without a gateway key, it also transcribes voice notes (decision 092) |
| `SYM_TRANSCRIBE_MODEL` | Optional. The model for voice notes, default `openai/gpt-transcribe`. It uses the AI Gateway, or OpenAI directly as above; `off` turns transcription off (decision 092) |
| `SYM_MODEL` | Optional. A gateway model ID, for example `anthropic/claude-sonnet-5.5`. With a direct provider, the provider's model ID, for example `claude-sonnet-5-5`; unset uses Eve's default for that provider |
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
| `SYM_CODE_CHANNELS` | Optional. `off` (default) or `on`. On gives each job a person must start its own Slack code channel, where the brief and Start post; a Slack refusal keeps it in its thread. Reinstall the app with the current manifest first (decision 067) |
| `SYM_VERIFIER` | Optional. `off` (default) or `on`. On runs the `verifier` subagent, a paid model call, on each finished code job. Off ends the job with the rule checks alone (decision 054) |
| `SYM_RESULT_WRITER` | Optional. `on` (default) or `off`. On runs the `writer` subagent, a model call, on each finished code job, so the result reads in the persona's voice. Off keeps the template result (decision 062) |
| `SYM_PR_FOLLOW` | Optional. `off` (default) or `on`. On asks the worker to watch each job's PR for 7 days and posts CI and review wakes in the job thread (decision 054) |
| `SYM_SANDBOX` | Optional. `off` (default) or `on`. On gives the brain a sandbox with `bash`, `read_file`, `write_file`, `glob`, and `grep`, one container per Slack thread, and lets it open files people share. Needs the Docker socket, see [Sandbox](#sandbox) (decision 089) |
| `SYM_SANDBOX_MEMORY` | Optional. Each sandbox's memory, such as `768m` or `2g`, at least `256m`. Default `1g`. Its files count against it: `/workspace` gets half and `/tmp` a quarter |
| `SYM_SANDBOX_NETWORK` | Optional. `off` (default) or `on`. On lets sandbox commands reach the network through Docker's default bridge. Off gives the container no network at all |
| `SYM_SANDBOX_IMAGE` | Optional. The sandbox image. Default: Eve's sandbox image (Ubuntu with Node.js, Python 3, git, ripgrep, jq, curl). It must run with a read-only root filesystem, give its default user bash and coreutils, and not run as root: Sym refuses an image whose default user is UID 0 |
| `DOCKER_GID` | compose.yaml only, with the sandbox. The group ID that owns `/var/run/docker.sock` on the host |
| `DOCKER_HOST` | Optional, with the sandbox. A Docker host for sandbox containers other than the mounted socket, such as `tcp://sandbox-host:2376` with `DOCKER_TLS_VERIFY=1` and `DOCKER_CERT_PATH` |
| `SYM_SLACK_USERS` | Slack user IDs allowed to use Sym, comma-separated |
| `SYM_CALLBACK_URL` | Base URL a worker uses to call Sym back, such as Sym's private-network address. Without it, jobs wait for the 4-minute poll (decision 028) |
| `SYM_SIGNIN_URL` | Base URL the owner's browser returns to after the worker sign-in, such as Sym's public HTTPS address. Must be https unless it is loopback. Defaults to `SYM_CALLBACK_URL` (decision 036) |
| `SYM_OWNER_SLACK_USER` | The owner's Slack user ID when there is no pack. Only the owner can sign Sym in to the worker |
| `SYM_WEBHOOK_KEY` | Optional. Turns on webhook triggers. Every webhook secret derives from it, so Postgres holds no secret; changing it changes every secret, and creators then rotate theirs. At least 32 characters, such as `openssl rand -hex 32`. Webhook URLs use `SYM_SIGNIN_URL`, else `SYM_CALLBACK_URL`, as their base (decision 090) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Optional. A GitHub App for `github` triggers and app mentions. Without all three, `/eve/v1/github` answers 404 (decision 091) |
| `GITHUB_APP_SLUG` | Optional. The app's name in mentions, such as `sym-app`. Without it, Sym ignores mentions |
| `LINEAR_AGENT_ACCESS_TOKEN`, `LINEAR_WEBHOOK_SECRET` | Optional. A Linear app for delegated issues and `linear` triggers. Without both, `/eve/v1/linear` answers 404 (decision 091) |
| `SYM_GITHUB_USERS`, `SYM_LINEAR_USERS` | Optional, without a pack. Comma-separated `<id>=<Slack user ID>` pairs: a GitHub account's numeric ID (a login maps nobody), or a Linear user ID or email. A pack's `identities` replaces them |
| `SYM_GITHUB_REPOS` | The repositories, comma-separated `owner/name`, whose events Sym may read. Without it (and without a pack's `githubRepositories`), GitHub triggers cannot be created (decision 091) |
| `SYM_TRIGGER_RUNS_PER_HOUR` | Optional. The most runs one trigger starts per hour, for Slack and webhook triggers. Default 20 (decision 088) |
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
   `/eve/v1/slack` and `/.well-known/workflow`, plus `/sym/hooks` and `/sym/reveal` when
   webhook triggers are on and `/eve/v1/github` or `/eve/v1/linear` when those apps are set
   up.
   Do not strip the path. Sym listens in the sidecar's network, so the domains point at the
   sidecar.
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

## Sandbox

The sandbox is off by default (decision 089). With `SYM_SANDBOX=on`, Sym starts one Docker
container per Slack thread for the brain's shell and file tools. The brain uses it to compute, to
open files people share in Slack, to run small scripts, and to prepare text or data. Repository
work still goes to the worker.

What each container gets:

- Eve's sandbox image, or `SYM_SANDBOX_IMAGE`, started as its default user with every Linux
  capability dropped and `no-new-privileges`, so `sudo` does nothing.
- 1 GB of memory and no extra swap (`SYM_SANDBOX_MEMORY`), 1 CPU, and 256 processes.
- A read-only root filesystem. `/workspace` (half the memory) and `/tmp` (a quarter) live in
  memory and count against the memory limit, so a sandbox cannot fill the host's disk.
- No network, unless `SYM_SANDBOX_NETWORK=on`. With no network a command cannot send a shared file
  anywhere, reach the host's private network or the tailnet, or read a cloud metadata endpoint. It
  also cannot install packages.
- The environment variable `AI_AGENT=eve` and nothing else: no Sym variable, no secret, no
  repository or git credentials.
- Removal, with its files, after 30 minutes with no sandbox call. Sym's `sandbox` schedule
  removes it every minute it finds one, so a command still running then is killed. The next
  call starts an empty sandbox.
- No container log, so nothing a command prints reaches Docker's log files on the host.

To turn it on with `compose.yaml`:

1. On the host, find the group that owns the Docker socket: `stat -c %g /var/run/docker.sock`.
2. In `compose.yaml`, uncomment the socket line under `sym` `volumes` and the `group_add` block.
3. Set `SYM_SANDBOX=on` and `DOCKER_GID` in the Environment tab, and redeploy.
4. Optional: pull the image ahead of the first use, about 550 MB:
   `docker pull ghcr.io/vercel/eve:dockerfile-fc0279bf1664`.
5. Ask Sym in Slack to run a small calculation, such as the sum of 2 and 3 in Python.

The trade-off: the Docker socket controls the host's Docker daemon, which is root on that host.
The brain never reaches it, because its commands run inside a sandbox container that has no
socket, and Sym runs only the fixed docker commands in `lib/sandbox/docker.ts`. But a bug in Sym
or a compromised dependency would reach it. To keep that risk off the Sym host, leave the socket
out and set `DOCKER_HOST` to a separate Docker host that runs only sandboxes.

Sandbox containers carry the label `sym.sandbox`. Each is removed when it goes idle or its
session ends, so none stay on the host.

Without the socket, keep `SYM_SANDBOX` off. With it on and no Docker, each sandbox tool says the
sandbox is unavailable and the turn continues; shared files reach the brain as a note.

## Webhook triggers

People on the allow-list can ask Sym to run an instruction when another system calls a URL
(decision 090). To turn this on:

1. Set `SYM_WEBHOOK_KEY` to a random value of at least 32 characters, and keep it in the secret
   store. Sym derives each trigger's secret from it.
2. Set `SYM_SIGNIN_URL` to Sym's public HTTPS base, so the URLs Sym hands out are reachable.
   Without it, Sym uses `SYM_CALLBACK_URL`, which suits senders on the private network only.
3. Expose `/sym/hooks/` and `/sym/reveal/` publicly at the proxy, unrewritten. The reveal page
   shows a creator their secret once, from a link Sym DMs them; it must open in their browser.
   Leave `/sym/hooks/` closed when no sender lives outside the private network.

A sender signs each POST: `x-sym-timestamp` is the Unix time in seconds, and `x-sym-signature`
is `sha256=` plus the hex HMAC-SHA256 of `<timestamp>.<raw body>` with the secret. Sym runs a
request once: a replay, or a copy re-signed within 10 minutes, is a duplicate. Two real events
with the same body inside 10 minutes need something unique in the body. Sym answers 202 when it
accepts a request, 200 for a duplicate, 401 for a missing, bad, or stale signature (more than 5
minutes off), 404 for an unknown URL, 409 for a paused trigger, 413 above 64 KiB, and 429 past
the hourly cap or for a bad signature after 30 in a minute. For example:

```sh
ts=$(date +%s); body='{"alert":"disk full"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$URL" -H 'content-type: application/json' -H "x-sym-timestamp: $ts" \
  -H "x-sym-signature: sha256=$sig" --data "$body"
```

Sym accepts no static bearer token: a leaked header would work forever, while a signature
expires in 5 minutes and covers the body.

## GitHub App

A GitHub App feeds `github` triggers and lets mapped people mention Sym on GitHub (decision 091).
Sym only reads events; it never edits repositories.

1. Create a GitHub App in your organization's settings. Set the webhook URL to
   `https://<public base>/eve/v1/github` and a random webhook secret.
2. Grant read-only repository permissions: Metadata, Issues, Pull requests, and Checks. Grant
   Issues and Pull requests write only if Sym should answer mentions with a comment.
3. Subscribe to the events Sym uses: Issues, Issue comment, Pull request, and Check suite.
4. Generate a private key. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the PEM), and
   `GITHUB_WEBHOOK_SECRET`, plus `GITHUB_APP_SLUG` for mentions. Keep them in the secret store.
5. Install the app on the repositories Sym may see. Every allowed person can watch any of
   them with a trigger, so install it only where that is fine.
6. List the repositories Sym may read in `SYM_GITHUB_REPOS` or the pack's `githubRepositories`.
   Map people by GitHub account ID: the pack's `identities` (`githubId: <id>`), or
   `SYM_GITHUB_USERS`. `gh api users/<login> --jq .id` prints an account's ID.
7. Expose `/eve/v1/github` publicly, unrewritten, and redeploy.

## Linear app

A Linear app lets mapped people delegate issues to Sym and feeds `linear` triggers (decision
091).

1. In Linear's settings, create an OAuth application with a webhook URL of
   `https://<public base>/eve/v1/linear`. Enable the Agent session events and the Issue data
   events.
2. Install it with `actor=app` and the `app:assignable` and `app:mentionable` scopes, so it
   appears as an agent, and read scopes for issues. Copy the app's access token and the webhook
   signing secret.
3. Set `LINEAR_AGENT_ACCESS_TOKEN` and `LINEAR_WEBHOOK_SECRET`. Eve rejects a webhook whose
   timestamp is more than 60 seconds off.
4. Map people: the pack's `identities` (`linear: <email or user ID>`), or `SYM_LINEAR_USERS`.
5. Expose `/eve/v1/linear` publicly, unrewritten, and redeploy.

A delegation from a mapped, allowed person becomes a DM in Slack, and Sym answers in Linear
where to continue. The work itself, including any Start for Builder, happens in Slack.

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
- Choose and configure the public route, including `/sym/hooks/` and `/sym/reveal/` for webhook triggers.
- Create and install the GitHub App and the Linear app, if wanted, and map people to Slack.
- Approve the worker sign-in and pick its access level, then re-approve every 30 days. Ask Sym
  to sign in to the worker for a new link.
- Approve permission prompts on the worker when a thread blocks.
- Set `SYM_MCP_<NAME>_TOKEN` and redeploy when Sym says an MCP connection needs a token, or
  approve the sign-in link Sym sends for an OAuth connection.
