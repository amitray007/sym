# Zone Z03: Build, deploy & runtime infra

## Summary

The core build machinery (Dockerfile, docker-compose.yml, .dockerignore, turbo.json, dokploy/README) is structurally sound: multi-stage Docker build, non-root user, `exec` as PID 1, pnpm frozen-lockfile, and the persistent `/data` volume pattern are all correct. The zone's health is dragged down by three clusters of problems. First, **three shell scripts** (`dev-setup.sh`, `setup-macos.sh`, `setup-linux.sh`) are wholly dead — they provision Postgres 16 and Redis 7 that were removed from the architecture, run a `pnpm db:migrate` that no longer exists, and will corrupt `.env` during the key-injection step because `.env.example` has no `SYM_ENCRYPTION_KEY=` placeholder. These files must be deleted before open-source launch. Second, **env-var documentation is fragmented and inconsistent**: `.env.example`, `dokploy/env-template.txt`, `dokploy/apps/agent.yml`, and the README env table each tell a different story — between them, `SLACK_OWNER_USER_TOKEN`, all six MCP/OAuth vars (`SYM_ENCRYPTION_KEY`, `SYM_PUBLIC_URL`, `SYM_MCP_SERVERS`, `SYM_CONFIG_PATH`, `SYM_DB_PATH`, `SYM_CLI_ALLOWLIST`), the behavior knobs, `SLACK_PUBLIC_BASE_URL` (needed for `manifest:render`), and `AGENT_URL` (needed for the smoke test) are variously missing from one or more files. Third, the Dockerfile ships devDependencies into the runtime image and misclassifies `dotenv` (used in `src/index.ts`) as a devDependency. Minor issues include a committed `slack/manifest.yml` with a developer's ngrok URL baked in, internal roadmap language ("Phase B", "Model B") in committed files, no Docker `HEALTHCHECK` directive, and an unpinned `node:24-slim` base.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                                                                                                         | Files                                                                                                | Effort                   |
| ------ | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------ | ------- |
| Z03-01 | critical | dead-code   | `dev-setup.sh` is wholly obsolete — installs Postgres+Redis, runs missing `db:migrate`, corrupts `.env`                                                                                                       | `scripts/dev-setup.sh`                                                                               | trivial                  |
| Z03-02 | critical | dead-code   | `setup-macos.sh` and `setup-linux.sh` install services the current stateless stack doesn't need                                                                                                               | `scripts/setup-macos.sh`, `scripts/setup-linux.sh`                                                   | trivial                  |
| Z03-03 | high     | docs        | `.env.example` is missing MCP/OAuth env vars that are conditionally required in production                                                                                                                    | `.env.example`                                                                                       | small                    |
| Z03-04 | high     | docs        | `dokploy/env-template.txt` missing `SLACK_OWNER_USER_TOKEN`, `SYM_ENCRYPTION_KEY`, `SYM_PUBLIC_URL`, `SYM_MCP_SERVERS`, and behavior knobs                                                                    | `dokploy/env-template.txt`                                                                           | small                    |
| Z03-05 | high     | docs        | `dokploy/apps/agent.yml` env list missing `AGENT_URL`, `SYM_PUBLIC_URL`, `SYM_ENCRYPTION_KEY`, `SYM_MCP_SERVERS`                                                                                              | `dokploy/apps/agent.yml`                                                                             | trivial                  |
| Z03-06 | high     | docs        | README env table is severely incomplete — missing `SLACK_OWNER_USER_TOKEN`, all `SYM_*` vars, behavior knobs, and `SLACK_PUBLIC_BASE_URL`                                                                     | `README.md`                                                                                          | small                    |
| Z03-07 | high     | security    | `slack/manifest.yml` containing a developer's personal ngrok URL is committed to the repo                                                                                                                     | `slack/manifest.yml`                                                                                 | trivial                  |
| Z03-08 | high     | docs        | `SLACK_PUBLIC_BASE_URL` (required for `pnpm manifest:render`) is not documented in `.env.example` or README                                                                                                   | `.env.example`, `README.md`, `slack/README.md`                                                       | trivial                  |
| Z03-09 | medium   | dependency  | `dotenv` is a `devDependency` but is imported in `src/index.ts` (production server entry point)                                                                                                               | `apps/agent/package.json`, `apps/agent/src/index.ts`                                                 | trivial                  |
| Z03-10 | medium   | performance | Dockerfile runtime stage copies the entire build — including devDependencies and source files — into the production image                                                                                     | `Dockerfile`                                                                                         | medium                   |
| Z03-11 | medium   | docs        | README "Repository layout" shows only `apps/agent` + `docs/FUTURE.md` — omits `packages/`, `slack/`, `dokploy/`, `scripts/`, `assets/`, `docker-compose.yml`                                                  | `README.md`                                                                                          | trivial                  |
| Z03-12 | medium   | docs        | README Setup §1 "Create a Slack app" lists wrong/incomplete scopes and missing events; diverged from `manifest.template.yml`                                                                                  | `README.md`, `slack/manifest.template.yml`                                                           | small                    |
| Z03-13 | medium   | ai-slop     | Internal roadmap labels "Phase B", "Phase B+C", "Phase C" in `manifest.template.yml` and `.env.example`; "Model B" in `docker-compose.yml`                                                                    | `slack/manifest.template.yml`, `.env.example`, `docker-compose.yml`                                  | trivial                  |
| Z03-14 | medium   | config      | `dokploy/apps/agent.yml` has a stale `TODO` comment for a non-existent `apps/agent/Dockerfile`                                                                                                                | `dokploy/apps/agent.yml`                                                                             | trivial                  |
| Z03-15 | low      | config      | Dockerfile uses `node:24-slim` without a pinned digest or patch version — non-reproducible across pulls                                                                                                       | `Dockerfile`                                                                                         | trivial                  |
| Z03-16 | low      | config      | No `HEALTHCHECK` directive in the Dockerfile; Dokploy relies solely on the post-deploy smoke test                                                                                                             | `Dockerfile`                                                                                         | small                    |
| Z03-17 | low      | security    | `setup-linux.sh` uses `curl …                                                                                                                                                                                 | sudo gpg`without POSIX`pipefail` — a failed download is silently ignored when dearmoring the GPG key | `scripts/setup-linux.sh` | trivial |
| Z03-18 | low      | docs        | `docker-compose.yml` header comment lists env vars but omits `SYM_ENCRYPTION_KEY`/`SYM_PUBLIC_URL` preamble connection to `docs/mcp-setup.md`                                                                 | `docker-compose.yml`                                                                                 | trivial                  |
| Z03-19 | low      | docs        | `scripts/dev-setup.sh` docstring (header comment) references `SYM_ENCRYPTION_KEY` injection but `.env.example` has no placeholder — the sed substitution would silently no-op even if the script were current | `scripts/dev-setup.sh`, `.env.example`                                                               | trivial                  |

---

## Detail

### Z03-01 — `dev-setup.sh` is wholly obsolete

**Evidence:**

- `scripts/dev-setup.sh:26–27` checks for `psql` and `redis-cli` which are never needed by the current stateless agent.
- Line 38: `createdb sym_dev` — no database exists or is used.
- Line 78: `pnpm db:migrate` — this script does not exist in either `package.json`; running it would fail with a non-zero exit.
- Lines 60–63: `sed` attempts to inject `SYM_ENCRYPTION_KEY=` into `.env`, but `.env.example` (the file that was just `cp`'d) contains no `SYM_ENCRYPTION_KEY=` line; the substitution finds nothing and the key is silently dropped.
- Lines 84–85: output references `DATABASE_URL` and `REDIS_URL` which are not part of the current stack.
- The script is not referenced from any `package.json` script, so it cannot be accidentally invoked.

**Recommendation:** Delete `scripts/dev-setup.sh`. It belongs to the removed stateful architecture and actively misleads contributors.

---

### Z03-02 — `setup-macos.sh` and `setup-linux.sh` install removed services

**Evidence:**

- `scripts/setup-macos.sh:24–46`: installs and starts `postgresql@16` via Homebrew.
- `scripts/setup-macos.sh:48–66`: installs and starts `redis` via Homebrew.
- `scripts/setup-linux.sh:30–65`: installs `postgresql-16` via the PGDG apt repo.
- `scripts/setup-linux.sh:69–99`: installs `redis-server` via the Redis apt repo.
- Neither Postgres nor Redis is listed in any `package.json` dependency or referenced in `apps/agent/src/`. Both services are absent from `docker-compose.yml` (removed, per the compose header comment).
- Neither script is referenced from any `package.json` script or README.

**Recommendation:** Delete both files. A new contributor reading `scripts/` will be confused — the directory should contain only currently-relevant tooling (`render-manifest.js`).

---

### Z03-03 — `.env.example` missing MCP/OAuth env vars

**Evidence:**
The following variables are read by `apps/agent/src/` but not present in `.env.example`:

| Variable                     | Where read                   | Condition                                     |
| ---------------------------- | ---------------------------- | --------------------------------------------- |
| `SYM_MCP_SERVERS`            | `mcp/source.ts:137`          | Legacy; needed if not using config file       |
| `SYM_CONFIG_PATH`            | `mcp/source.ts:44`           | Optional; override connector config file path |
| `SYM_ENCRYPTION_KEY`         | `mcp/store.ts:159`           | Required when using OAuth MCP connectors      |
| `SYM_PUBLIC_URL`             | `mcp/providers/oauth.ts:270` | Required for OAuth callback routing           |
| `SYM_DB_PATH`                | `mcp/store.ts:156`           | Optional; override credential store path      |
| `SYM_CLI_ALLOWLIST`          | `run-cli.ts:68`              | Optional; controls `run_cli` access           |
| `SYM_MCP_CONNECT_TIMEOUT_MS` | `mcp/dispatcher.ts:54`       | Optional; timeout per MCP connect             |

`docs/mcp-setup.md` documents these thoroughly but `.env.example` doesn't link to it and provides no entries for them.

**Recommendation:** Add a `# ── MCP connectors ────…` section to `.env.example` with commented-out entries and a pointer to `docs/mcp-setup.md`. At minimum add `SYM_ENCRYPTION_KEY` and `SYM_PUBLIC_URL` since they are required for any OAuth connector.

---

### Z03-04 — `dokploy/env-template.txt` missing vars

**Evidence:**
Comparing `env-template.txt` against `config.ts` + `mcp/` reads:

- **Missing required for OAuth connectors:** `SYM_ENCRYPTION_KEY`, `SYM_PUBLIC_URL`
- **Missing optional MCP config:** `SYM_MCP_SERVERS`, `SYM_CONFIG_PATH`
- **Missing optional Slack:** `SLACK_OWNER_USER_TOKEN`
- **Missing behavior knobs:** `TASK_CARD_THRESHOLD`, `TASK_CARD_AFTER`, `OWNER_POST_MARKER`
- `AGENT_URL` IS present (for the smoke test hook) — this is correct.
- `FIREWORKS_BASE_URL` is missing (present in `agent.yml` but absent from `env-template.txt`).

**Recommendation:** Extend `env-template.txt` to include all vars that a Dokploy operator might need, grouped with comments matching the existing style.

---

### Z03-05 — `dokploy/apps/agent.yml` env list incomplete

**Evidence:**
`dokploy/apps/agent.yml:23–40` lists exactly 10 env var names. Missing entries:

- `AGENT_URL` — required for the post-deploy smoke test (the hook script `die`s without it).
- `SYM_PUBLIC_URL` — required for OAuth MCP connectors.
- `SYM_ENCRYPTION_KEY` — required for OAuth MCP connectors.
- `SYM_MCP_SERVERS` — needed for legacy connector wiring.
- `SLACK_OWNER_USER_TOKEN` — needed for user-scoped Slack tools.

**Recommendation:** Add the missing entries. If `agent.yml` is intended as documentation of all knobs rather than an active Dokploy schema, that should be stated explicitly.

---

### Z03-06 — README env table severely incomplete

**Evidence:**
`README.md:25–35` documents only 9 vars. The agent reads at least 18 distinct env vars. Missing from the table:

- `SLACK_OWNER_USER_TOKEN` (optional, enables user-scoped Slack tools)
- All behavior knobs: `TASK_CARD_THRESHOLD`, `TASK_CARD_AFTER`, `OWNER_POST_MARKER`
- All MCP/OAuth vars: `SYM_MCP_SERVERS`, `SYM_CONFIG_PATH`, `SYM_ENCRYPTION_KEY`, `SYM_PUBLIC_URL`, `SYM_DB_PATH`, `SYM_CLI_ALLOWLIST`
- `SLACK_PUBLIC_BASE_URL` (needed for `pnpm manifest:render`, documented in `slack/README.md` but not in the root README)

**Recommendation:** Expand the README env table with the full set, grouped by concern (Slack, Fireworks, Agent, MCP). Reference `docs/mcp-setup.md` for the MCP cluster.

---

### Z03-07 — `slack/manifest.yml` with developer's ngrok URL is committed

**Evidence:**
`slack/manifest.yml:39,45,113,115` contains literal URLs:

```
url: https://snowdrop-reliably-blazing.ngrok-free.dev/slack/commands
- https://snowdrop-reliably-blazing.ngrok-free.dev/slack/oauth/callback
request_url: https://snowdrop-reliably-blazing.ngrok-free.dev/slack/interactivity
request_url: https://snowdrop-reliably-blazing.ngrok-free.dev/slack/events
```

The file comment even names the developer's personal ngrok subdomain (`snowdrop-reliably-blazing.ngrok-free.dev`). While `slack/manifest.yml` is in `.gitignore` (`.gitignore:47`), the file exists locally and is NOT excluded by `git ls-files` — it was committed at some point. A public clone would expose this URL.

**Recommendation:** Confirm `slack/manifest.yml` is not tracked (`git rm --cached slack/manifest.yml` if needed). Add a check (CI or pre-commit hook) that blocks committing rendered manifests. The `.gitignore` entry is correct — just verify the file is not currently tracked.

---

### Z03-08 — `SLACK_PUBLIC_BASE_URL` not documented in `.env.example`

**Evidence:**
`scripts/render-manifest.js:18` reads `process.env.SLACK_PUBLIC_BASE_URL`. This variable is documented in `slack/README.md:12` and `slack/manifest.template.yml:9-10`, but:

- Not in `.env.example`
- Not in `README.md` env table
- `slack/README.md:26` says "the ngrok tunnel URL from your `.env`" but there's no entry in `.env.example` to put it in

**Recommendation:** Add `SLACK_PUBLIC_BASE_URL=` (commented out) to `.env.example` with a note that it's only needed for `pnpm manifest:render`. Link `slack/README.md` from the root README setup section.

---

### Z03-09 — `dotenv` misclassified as `devDependency`

**Evidence:**
`apps/agent/package.json` places `dotenv` in `devDependencies`:

```json
"devDependencies": {
  "dotenv": "^16.4.7",
  ...
}
```

But it is imported in the production server entry point:

```typescript
// apps/agent/src/index.ts:5
import { config as loadDotenv } from 'dotenv';
```

This works today because the Dockerfile runs `pnpm install --frozen-lockfile` (installs all deps) but would break with `pnpm install --prod`. It also signals wrong intent to contributors.

**Recommendation:** Move `dotenv` from `devDependencies` to `dependencies` in `apps/agent/package.json`.

---

### Z03-10 — Runtime image ships devDependencies and source files

**Evidence:**
`Dockerfile:47`:

```dockerfile
COPY --from=build --chown=node:node /repo /repo
```

This copies the entire monorepo from the build stage, including:

- All `node_modules` (dev + prod) across every workspace
- All `src/` TypeScript source files
- Test files (`tests/`)
- Build tooling (`eslint.config.js`, `tsconfig*.json`, `scripts/`)

The production image only needs:

- `apps/agent/dist/` (compiled output)
- `node_modules/` (production dependencies only)
- Workspace package `dist/` folders for `@sym/kernel`, `@sym/contracts`, `@sym/adapter-slack`

The presence of `ink`, `react`, `vitest`, `tsx` in the production image is unnecessary bloat. `ink` and `react` are prod deps (needed for the `sym` CLI TUI) but `vitest`, `tsx`, and test libraries are not.

**Recommendation:** Add a `pnpm prune --prod` step in the build stage before copying to the runtime stage, and copy only the necessary `dist/` trees and `node_modules/`. This typically halves the image size for TypeScript monorepos.

---

### Z03-11 — README repo layout omits most of the repo

**Evidence:**
`README.md:77–83`:

```
apps/
  agent/    Hono server — …
docs/
  FUTURE.md Parked features …
```

Actual top-level contents include `packages/` (3 members), `slack/`, `dokploy/`, `scripts/`, `assets/`, `docker-compose.yml`, `Dockerfile`. A new contributor cloning the repo cannot orient themselves from the README.

**Recommendation:** Update the layout section to list all first-class directories with one-line descriptions.

---

### Z03-12 — README §1 scope list diverged from manifest template

**Evidence:**
`README.md:42–44` tells contributors to add:

```
im:write
```

But `slack/manifest.template.yml` has `im:read` (not `im:write`) in bot scopes. The README also omits `assistant:write`, `commands`, `groups:read`, `im:read`, `mpim:read`, `users:read.email`, and the user scopes entirely. The events list in README (line 46) is missing `message.mpim`, `assistant_thread_started`, `assistant_thread_context_changed`.

**Recommendation:** Replace the manual scope list in README §1 with a reference to `slack/manifest.template.yml` and the `pnpm manifest:render` workflow. The template is the single source of truth; duplicating the list invites drift.

---

### Z03-13 — Internal roadmap labels in committed files

**Evidence:**

- `slack/manifest.template.yml:69,77,107`: `# Phase B — act-as-owner writes`, `# Phase B+C feature work`, `# required for confirmation buttons (Phase B`
- `.env.example:21`: `# Setting the owner's status / reminders / posting as the owner (Phase B)`
- `docker-compose.yml:29`: `# + any ambient CLI config dirs (Model B, e.g. CLOUDSDK_CONFIG=/data/gcloud)`

"Phase B", "Phase C", and "Model B" are internal project-management labels with no meaning to an open-source contributor.

**Recommendation:** Replace with outcome-oriented language: "Phase B → act-as-owner writes" becomes "owner-identity writes (post, react, set status, reminders)". "Model B" in docker-compose becomes "CLOUDSDK_CONFIG=/data/gcloud for gcloud auth".

---

### Z03-14 — Stale TODO in `dokploy/apps/agent.yml`

**Evidence:**
`dokploy/apps/agent.yml:13`:

```yaml
# TODO: dockerfile: apps/agent/Dockerfile
```

`apps/agent/Dockerfile` does not exist (only the root `Dockerfile` does). The current config correctly uses the root Dockerfile with `context: .`.

**Recommendation:** Remove the TODO comment, or add a note explaining that the monorepo Dockerfile at repo root is intentional.

---

### Z03-15 — Unpinned base image tag

**Evidence:**
`Dockerfile:15,27`:

```dockerfile
FROM node:24-slim AS base
FROM node:24-slim AS runtime
```

`node:24-slim` is a floating tag. A re-build six months from now may pull a different Node 24.x patch with a different OS base, silently changing behavior.

**Recommendation:** Pin to a specific digest or at minimum a patch version (e.g., `node:24.4.0-slim@sha256:…`). The `.nvmrc` says `24` — align both to a specific patch version.

---

### Z03-16 — No `HEALTHCHECK` directive in Dockerfile

**Evidence:**
`Dockerfile` contains no `HEALTHCHECK` instruction. Container orchestrators (Dokploy, Docker Compose, Kubernetes) use `HEALTHCHECK` for automatic restart on failure. The post-deploy smoke test covers the deploy step but not steady-state liveness monitoring.

**Recommendation:** Add `HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl -sf http://localhost:3001/health || exit 1` to the Dockerfile. (The `curl` binary is already installed in the runtime stage.)

---

### Z03-17 — `setup-linux.sh` pipe safety (curl | gpg without pipefail)

**Evidence:**
`scripts/setup-linux.sh:38–39,73–74`:

```sh
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | $SUDO gpg --dearmor -o "$PGDG_KEY"
```

With `#!/bin/sh` and `set -eu` (no `-o pipefail`, which is bash-only), the exit code of this pipeline is `gpg`'s exit code, not `curl`'s. If `curl -f` exits non-zero (HTTP error), the shell interprets `gpg` succeeding (writing 0 bytes) as success. The GPG key file would exist but be empty, and the subsequent `apt-get update` would silently trust an empty key ring.

(Note: this script is also dead code per Z03-02, so the fix is deletion. But the pattern is worth documenting.)

**Recommendation:** Delete the script (Z03-02). If ever rewritten, download to a temp file first, verify, then import.

---

### Z03-18 — `docker-compose.yml` comment omits MCP env reference

**Evidence:**
`docker-compose.yml:12–15`:

```yaml
# Provide secrets/config via a repo-root .env (see docs/mcp-setup.md):
#   SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, SLACK_BOT_USER_ID, SLACK_TEAM_ID,
#   SYM_OWNER_SLACK_USER_ID, FIREWORKS_API_KEY, FIREWORKS_MODEL,
#   SYM_MCP_SERVERS (optional), and for OAuth connectors:
#   SYM_ENCRYPTION_KEY + SYM_PUBLIC_URL.
```

The comment is a reasonable summary but `SLACK_OWNER_USER_TOKEN` is omitted and the connection to `docs/mcp-setup.md` is only in the very first line — easy to miss. Minor.

**Recommendation:** Add `SLACK_OWNER_USER_TOKEN (optional)` to the list.

---

### Z03-19 — `dev-setup.sh` SYM_ENCRYPTION_KEY injection silently no-ops

**Evidence:**
`scripts/dev-setup.sh:50–63` generates a random key and attempts to splice it into the newly created `.env` via `sed`. The template it splices from (`.env.example`) does not contain a `SYM_ENCRYPTION_KEY=` line — so the `sed` substitution finds nothing to replace and exits 0. The generated key is computed but discarded. No error is reported.

This is a secondary finding under Z03-01 (the whole script is dead code), but the root cause is that `.env.example` was never updated when `SYM_ENCRYPTION_KEY` was introduced. This makes Z03-03 (adding the var to `.env.example`) a prerequisite if the script were ever revived.

**Recommendation:** Delete the script (Z03-01). If a new dev-bootstrap script is ever written, add `SYM_ENCRYPTION_KEY=` to `.env.example` first.

---

## Proposed chunks

These are ordered by dependency and impact. Each chunk is one shippable, reviewable unit.

### Chunk A — Delete dead scripts (prerequisite for everything; unblocks clean docs)

**Goal:** Remove the three shell scripts that predate the stateless architecture, leaving no dead files in `scripts/`.

**Findings:** Z03-01, Z03-02, Z03-17, Z03-19

**Depends on:** nothing

**Work:**

1. `git rm scripts/dev-setup.sh scripts/setup-macos.sh scripts/setup-linux.sh`
2. If any CI or package.json script references them, remove those references (none currently exist).

---

### Chunk B — Fix env-var documentation across all config files

**Goal:** Every env var the agent reads appears at least once in `.env.example` (with a comment), and all deployment config files (`env-template.txt`, `agent.yml`) are consistent with each other and with the code.

**Findings:** Z03-03, Z03-04, Z03-05, Z03-08, Z03-18

**Depends on:** nothing (independent of Chunk A)

**Work:**

1. Add MCP/OAuth section to `.env.example` (with commented-out vars; pointer to `docs/mcp-setup.md`).
2. Add `SLACK_PUBLIC_BASE_URL=` entry (commented) to `.env.example`.
3. Extend `dokploy/env-template.txt` with missing vars.
4. Extend `dokploy/apps/agent.yml` env list with `AGENT_URL`, `SYM_PUBLIC_URL`, `SYM_ENCRYPTION_KEY`, `SYM_MCP_SERVERS`, `SLACK_OWNER_USER_TOKEN`.
5. Add `SLACK_OWNER_USER_TOKEN` to `docker-compose.yml` header comment.

---

### Chunk C — Update README to reflect current reality

**Goal:** A new contributor reading the README gets a correct, complete picture of the repo layout, env vars, and Slack setup steps.

**Findings:** Z03-06, Z03-11, Z03-12

**Depends on:** Chunk B (so the README env table references finalized env var names)

**Work:**

1. Expand env table to include all vars; link to `docs/mcp-setup.md` for MCP section.
2. Update "Repository layout" section to include `packages/`, `slack/`, `dokploy/`, `scripts/` (after Chunk A, `scripts/` will contain only `render-manifest.js`).
3. Replace manual scope list in §1 with "use `pnpm manifest:render` + paste `slack/manifest.yml`" workflow; remove stale scope list and wrong `im:write`.

---

### Chunk D — Remove internal roadmap language and stale TODOs

**Goal:** No internal phase labels or stale TODO comments in any committed file.

**Findings:** Z03-13, Z03-14

**Depends on:** nothing

**Work:**

1. Replace "Phase B", "Phase B+C", "Phase C" comments in `manifest.template.yml` with outcome descriptions.
2. Replace "Phase B" in `.env.example`.
3. Replace "Model B" in `docker-compose.yml`.
4. Remove the stale TODO in `dokploy/apps/agent.yml`.

---

### Chunk E — Fix manifest.yml committed state

**Goal:** `slack/manifest.yml` is not tracked by git and contains no developer-specific URLs.

**Findings:** Z03-07

**Depends on:** nothing

**Work:**

1. `git rm --cached slack/manifest.yml` if tracked.
2. Verify `.gitignore` entry is effective (`slack/manifest.yml`).
3. Optionally add a CI check that fails if `slack/manifest.yml` is staged.

---

### Chunk F — Fix `dotenv` dependency classification

**Goal:** `dotenv` is in `dependencies`, not `devDependencies`, matching its use in the production entry point.

**Findings:** Z03-09

**Depends on:** nothing

**Work:**

1. Move `dotenv` from `devDependencies` to `dependencies` in `apps/agent/package.json`.
2. `pnpm install` to update the lockfile.
3. Verify `pnpm build` and `pnpm test` pass.

---

### Chunk G — Add HEALTHCHECK and improve Dockerfile

**Goal:** The container advertises its own health and the base image is reproducibly pinned.

**Findings:** Z03-15, Z03-16

**Depends on:** nothing

**Work:**

1. Add `HEALTHCHECK` directive before `USER node` in the Dockerfile.
2. Pin `node:24-slim` to a specific digest or patch tag (coordinate with `.nvmrc`).

---

### Chunk H — Production image pruning (nice-to-have, last)

**Goal:** The runtime image contains only production `node_modules` and compiled `dist/` — no devDependencies, no source files.

**Findings:** Z03-10

**Depends on:** Chunk F (dotenv must be in `dependencies` before a `--prod` install)

**Work:**

1. In the build stage, run `pnpm prune --prod` after `pnpm build`.
2. In the runtime stage, copy only the required `dist/` trees and pruned `node_modules/`.
3. Validate the image works end-to-end (server starts, `/health` responds).
