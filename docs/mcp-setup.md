# MCP connector setup

Sym can connect to MCP servers and expose their tools to the agent alongside its
built-ins. Connectors are declared in the `SYM_MCP_SERVERS` env var (a JSON
array). Each entry is one connector.

```
Connector = Transport × Acquisition × Injection
  transport:   stdio (a CLI / binary / custom server)  |  http (Streamable HTTP)
  acquisition: static (Sym holds the secret) | oauth | ambient (the CLI holds its own) | none
  injection:   env | argv | file | header   (how Sym hands a static secret to the server)
```

## Env vars

| Var                          | Purpose                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `SYM_CONFIG_PATH`            | connector config file (default `.sym/config.json`; set to `/data/sym/config.json` on the deploy). Source of truth when present |
| `SYM_MCP_SERVERS`            | JSON array of connectors — **legacy fallback**, used only when the config file is absent                                       |
| `SYM_MCP_CONNECT_TIMEOUT_MS` | per-connector connect timeout (default `10000`)                                                                                |
| `SYM_ENCRYPTION_KEY`         | 32-byte base64/hex — encrypts the OAuth token store (required only for OAuth connectors; fail-closed without it)               |
| `SYM_DB_PATH`                | OAuth token store path (default `.sym/credentials.db`)                                                                         |
| `SYM_PUBLIC_URL`             | public HTTPS base for the OAuth callback (`/oauth/callback/:slug`)                                                             |

## Config file + live reload (the control-plane seam)

Connector wiring now lives in a JSON **config file** (`SYM_CONFIG_PATH`, default
`.sym/config.json`), not just the env var. The file is the source of truth when
present; `SYM_MCP_SERVERS` is a legacy fallback used only when the file is absent.
A malformed file falls back to env (fail-open) so a bad edit never strands the
agent at zero connectors. **Secrets do not belong in this file** — wiring +
`secretRef`s only.

```jsonc
// .sym/config.json
{
  "version": 1,
  "mcpServers": [
    {
      "name": "sentry",
      "transport": { "kind": "stdio", "command": "sentry-mcp" },
      "auth": {
        "kind": "static",
        "secret": "…",
        "inject": { "at": "env", "name": "SENTRY_AUTH_TOKEN" },
      },
    },
  ],
}
```

The running agent reconciles the live connector pool **without a restart** via a
loopback-only admin route — this is the seam the `sym` CLI's `apply`/`status`
will call. Edit the file, then:

```bash
# inside the container (or locally): apply the file to the live pool
curl -s -X POST http://127.0.0.1:3001/admin/reload | jq
#   → { "source": "file", "connectors": [ { "name": "sentry", "status": "connected", "tools": 12 } ], "totalTools": 12 }

# read-only: what's live right now
curl -s http://127.0.0.1:3001/admin/status | jq
```

Reconcile is **validate-then-swap**: a connector that fails to connect leaves the
previously-healthy one serving (`status: "failed-kept-previous"`); unchanged
connectors are left untouched (no reconnect churn); dropped ones are closed
(`status: "removed"`). The routes refuse any non-loopback caller — the CLI hits
`127.0.0.1` from inside the container; proxied traffic is rejected.

## The two credential models

**Model A — Sym holds the credential.** A static token (injected via `env`/`header`)
or a service-account key file (`file` injection → materialized to a tmpfs file →
pointer env), or OAuth tokens in the encrypted store. Scoped, portable,
encrypted at rest. **Default — prefer this.**

**Model B — the wrapped CLI holds its own credential ("ambient").** You log into
the CLI **once** (e.g. `gcloud auth login`); it writes creds to its own config
dir on disk; Sym just spawns the CLI as an MCP server pointed at that dir and
sets **no** credential. Sym never sees a key. Use this when you want
"log in as me once, no key in Sym" — but it grants the CLI's full identity and
stores creds in plaintext on disk (see edge cases).

**Which model?**

```
Does the tool's login AUTO-REFRESH creds (OAuth refresh token, e.g. gcloud)?
  NO  (static token: sentry, gh, influx, hubspot)  → Model A (inject token via env). B adds nothing.
  YES (gcloud user / ADC login)
       need least-privilege / portability?         → Model A (service-account key, file inject)   [default]
       want "log in once, no key in Sym"?          → Model B (ambient)                              [opt-in]
```

---

## Local setup (your laptop)

Local is simpler than the deploy: **your filesystem is persistent and Sym runs as
you**, so there is no volume / UID / headless-login / config-dir-relocation to
worry about. Two places env goes:

- **Running Sym** (`pnpm --filter @sym/agent dev`) loads the **repo-root `.env`**,
  and it is loaded with `override: true` — so `.env` _wins over_ shell exports.
  Put connector config in `<repo>/.env`.
- **The `qa:mcp` harness** does **not** load `.env` — it reads `process.env`
  directly. Pass vars **inline** on the command.

Recommended loop: verify a connector with the harness first (no Slack), then move
it into `.env` and run the agent.

### Model B locally (gcloud)

The spawned MCP subprocess inherits your `$HOME`, so gcloud finds your
`~/.config/gcloud` automatically — no `CLOUDSDK_CONFIG`, no `auth` injection.

```bash
# 1) one-time real login (normal browser flow)
gcloud auth application-default login

# 2) verify with the harness (inline env, no Slack)
SYM_MCP_SERVERS='[{"name":"gcloud","transport":{"kind":"stdio","command":"npx","args":["-y","@google-cloud/gcloud-mcp"]},"auth":{"kind":"ambient"},"trust":false}]' \
SYM_MCP_CONNECT_TIMEOUT_MS=60000 \
pnpm --filter @sym/agent qa:mcp

# 3) once it lists tools, add the same JSON to repo-root .env, then:
pnpm --filter @sym/agent dev
```

`"auth":{"kind":"ambient"}` is an explicit marker: "this connector
self-authenticates from disk; Sym injects nothing." It also gives a clearer
"not logged in" diagnostic if the connector comes back with zero tools. (You can
omit `auth` entirely and it still works — the marker is for clarity + diagnostics.)

### Model A locally (service-account key or token)

```bash
# service-account key via file injection (materialized to a tmpfs file)
SYM_MCP_SERVERS='[{"name":"gcloud","transport":{"kind":"stdio","command":"npx","args":["-y","@google-cloud/gcloud-mcp"]},
  "auth":{"kind":"static","secret":"<SA-KEY JSON one line>","inject":{"at":"file","path":"key.json","pointerEnv":"GOOGLE_APPLICATION_CREDENTIALS"}},"trust":false}]' \
pnpm --filter @sym/agent qa:mcp

# static token (sentry, gh, …) via env injection
SYM_MCP_SERVERS='[{"name":"sentry","transport":{"kind":"stdio","command":"npx","args":["@sentry/mcp-server@latest"]},
  "auth":{"kind":"static","secret":"sntrys_…","inject":{"at":"env","name":"SENTRY_AUTH_TOKEN"}},"trust":false}]' \
pnpm --filter @sym/agent qa:mcp
```

### Harness reference

```bash
SYM_MCP_SERVERS='[…]' \
SYM_QA_TOOL='name__tool' SYM_QA_ARGS='{"k":"v"}' \   # optional: also call one tool
SYM_MCP_CONNECT_TIMEOUT_MS=60000 \                    # optional: bump for cold npx downloads
pnpm --filter @sym/agent qa:mcp
```

---

## Deploy setup (Docker / Dokploy)

The container's filesystem is **ephemeral** — rebuilt from the image on every
redeploy/restart, so anything installed _into a running container_ is lost. Only
**two** things survive: the **image** (what the Dockerfile baked) and the
**`/data` volume**. The image is deliberately **CLI-agnostic** (generic runtimes
only: node, python3, curl), so the actual tools live on `/data` and you never
edit the Dockerfile to add one.

### Persistent tools on /data (no CLIs in the image)

Mount one persistent volume at `/data`. `/data/bin` is on `PATH`, so any binary
or npm-global you put there is found by name. Provision it **once** (via
`docker exec`); it then survives every redeploy — install + login are not lost.

```
/data                         (persistent volume — the ONLY durable state)
  bin/                        ← on PATH: tool binaries + npm-global bins land here
    shopify-dev-mcp           (npm: @shopify/dev-mcp)
    gcloud-mcp                (npm: @google-cloud/gcloud-mcp)
    gcloud  → ../google-cloud-sdk/bin/gcloud   (symlink)
  lib/                        ← npm-global modules (npm i -g --prefix /data)
  google-cloud-sdk/           ← the gcloud SDK, extracted here
  gcloud/                     ← CLOUDSDK_CONFIG=/data/gcloud  (the login — persists)
  credentials.db              ← SYM_DB_PATH=/data/credentials.db  (OAuth store)
```

### One-time provisioning (run once via `docker exec`)

Runs as the `node` user (the image's `USER`), writing to the node-owned volume —
no root, no rebuild. Re-run only if you ever recreate the volume.

```bash
docker exec -it sym-agent bash      # Dokploy: use its container terminal

# 1) MCP server packages → /data  (bins land in /data/bin, already on PATH)
npm i -g --prefix /data @shopify/dev-mcp@1.13.3 @google-cloud/gcloud-mcp@0.5.3

# 2) gcloud SDK → /data, expose its `gcloud` on PATH  (uses python3 from the image)
cd /tmp
curl -sSLO https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz
tar -xf google-cloud-cli-linux-x86_64.tar.gz -C /data       # → /data/google-cloud-sdk
ln -sf /data/google-cloud-sdk/bin/gcloud /data/bin/gcloud
# (arm64 host? use google-cloud-cli-linux-arm.tar.gz)

# 3) one-time gcloud login → writes creds to /data/gcloud (persists on the volume)
export CLOUDSDK_CONFIG=/data/gcloud
gcloud auth login --no-launch-browser
gcloud auth application-default login --no-launch-browser   # if the server uses ADC
gcloud config set project <PROJECT_ID>
```

### Connector config (point commands at the /data tools)

No `npx` at runtime → no package download, no connect timeout. Commands resolve
from `/data/bin` via `PATH`:

```jsonc
[
  {
    "name": "shopify-dev-mcp",
    "transport": { "kind": "stdio", "command": "shopify-dev-mcp" },
    "trust": false,
  },
  {
    "name": "gcloud",
    "transport": {
      "kind": "stdio",
      "command": "gcloud-mcp",
      "env": { "CLOUDSDK_CONFIG": "/data/gcloud" },
    },
    "auth": { "kind": "ambient" },
    "trust": false,
  },
]
```

After provisioning, **redeploy** (or restart): the tools _and_ the gcloud login
are all on `/data`, so the connectors come up immediately and stay up across
future redeploys. Back up `/data` — it holds the plaintext gcloud refresh token
plus the OAuth store.

> uvx-based (Python) MCP servers work the same way: install `uv` onto `/data/bin`
> (its installer is a single `curl`) and point the connector at it. Static-token
> servers (e.g. `@sentry/mcp-server`) need no login at all — `npm i -g --prefix
/data` the package and pass the token via `inject.env`.

---

## Model B edge cases (read before relying on it)

| Edge case                      | Why                                                                     | Mitigation                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Config-dir relocation varies   | gcloud=`CLOUDSDK_CONFIG` (surgical); sentry/gh=`HOME`-based or per-tool | Prefer a dedicated env; if only `HOME`, set a per-connector `HOME`         |
| Mutable dir, runtime writes    | gcloud caches/refreshes tokens into the dir at runtime                  | Volume must be **writable**; snapshot the whole dir for backups            |
| Concurrency / SQLite locks     | shared config dir + parallel tool calls                                 | gcloud locks internally; heavy concurrency may need retries                |
| Slow connect when unconfigured | gcloud probes the GCE metadata server (retries) off-GCE                 | set `GOOGLE_APPLICATION_CREDENTIALS` / raise `SYM_MCP_CONNECT_TIMEOUT_MS`  |
| Not logged in = silent 0 tools | fail-open contributes nothing                                           | the `ambient` marker emits a "check login" hint; boot log lists connectors |
| Plaintext creds at rest        | ambient creds aren't encrypted (unlike the OAuth store)                 | secure the volume + backups                                                |
| Single identity per dir        | one config dir = one identity/project                                   | separate dirs per identity                                                 |
| Expiry / revocation            | gcloud ADC refresh tokens can be revoked / expire                       | re-login runbook; Sym can't refresh (the CLI owns it)                      |
| UID / permissions              | login writes `0600` as one user; container runs as another              | chown the volume / match UID                                               |
| CLI must be reachable          | the MCP server shells `gcloud`                                          | install the CLI onto `/data/bin` (on `PATH`) — persists, no image change   |

**Security:** keep ambient / infra-mutating connectors **confirm-gated** (do not
`trust:true` something that can change infra under your full identity).

---

## OAuth connectors (status)

The OAuth machinery (encrypted token store, `/oauth/callback/:slug`, refresh) is
implemented. The in-Slack "Connect" button that surfaces the authorize URL and
handles consent (**C3b**) is not yet built — so OAuth connectors (Gmail/Calendar)
are not yet usable end-to-end from Slack. Static (env/file) and ambient connectors
are fully usable.
