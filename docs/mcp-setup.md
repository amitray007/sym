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

| Var                          | Purpose                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SYM_MCP_SERVERS`            | JSON array of connectors (see below)                                                                             |
| `SYM_MCP_CONNECT_TIMEOUT_MS` | per-connector connect timeout (default `10000`)                                                                  |
| `SYM_ENCRYPTION_KEY`         | 32-byte base64/hex — encrypts the OAuth token store (required only for OAuth connectors; fail-closed without it) |
| `SYM_DB_PATH`                | OAuth token store path (default `.sym/credentials.db`)                                                           |
| `SYM_PUBLIC_URL`             | public HTTPS base for the OAuth callback (`/oauth/callback/:slug`)                                               |

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

The container's filesystem is **ephemeral** and it runs as a **non-you UID**, so
durable credential state needs a **persistent volume**, and Model B's
config dir must be relocated onto it.

### Persistent volume — the only durable state

Mount one persistent volume at `/data` and route both the OAuth store and any
ambient config dirs into it. Conversation stays stateless (the Slack thread is
the memory); `/data` is the only thing that must survive restarts.

```
/data                       (persistent volume — writable, UID-matched, secured, backed up)
  credentials.db            ← SYM_DB_PATH=/data/credentials.db   (OAuth store, AES-256-GCM)
  gcloud/                    ← Model B: CLOUDSDK_CONFIG=/data/gcloud
    credentials.db           (refresh token, 0600)
    access_tokens.db         (mutable cache — gcloud writes this at RUNTIME → volume must be writable)
    configurations/
```

### Model B on the deploy

```jsonc
{
  "name": "gcloud",
  "transport": {
    "kind": "stdio",
    "command": "gcloud-mcp-server",
    "env": { "CLOUDSDK_CONFIG": "/data/gcloud" },
  }, // relocate gcloud's config onto the volume
  "auth": { "kind": "ambient" },
  "trust": false,
}
```

One-time login on the box (headless):

```bash
docker exec -it <container> sh
CLOUDSDK_CONFIG=/data/gcloud gcloud auth application-default login --no-launch-browser
# paste the URL into a browser, authorize, paste the code back
```

Requirements: the `gcloud` CLI must be in the image and on `PATH`; the container's
UID must be able to read/write `/data/gcloud` (the `0600` files); back up `/data`
(it holds plaintext refresh tokens).

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
| CLI must be in the image       | the MCP server shells `gcloud`                                          | bake the CLI into the deploy image                                         |

**Security:** keep ambient / infra-mutating connectors **confirm-gated** (do not
`trust:true` something that can change infra under your full identity).

---

## OAuth connectors (status)

The OAuth machinery (encrypted token store, `/oauth/callback/:slug`, refresh) is
implemented. The in-Slack "Connect" button that surfaces the authorize URL and
handles consent (**C3b**) is not yet built — so OAuth connectors (Gmail/Calendar)
are not yet usable end-to-end from Slack. Static (env/file) and ambient connectors
are fully usable.
