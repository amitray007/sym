# syntax=docker/dockerfile:1
#
# Sym agent — production image (single deployable).
# pnpm + turbo monorepo: builds apps/agent and its workspace deps
# (@sym/kernel, @sym/contracts, @sym/adapter-slack), then runs the agent.
#
# This image is deliberately CLI-AGNOSTIC. It bakes in only GENERIC runtimes
# (node, python3, uv/uvx, curl) — never a specific CLI. The actual tools you connect —
# CLIs like gcloud and the MCP server packages (shopify-dev-mcp, gcloud-mcp, …) —
# are installed ONCE onto the persistent /data volume, NOT into this image. They
# live on /data/bin (which is on PATH), so they survive every redeploy/restart
# and you never edit this file to add a tool.
# See docs/mcp-setup.md → "Persistent tools on /data (no CLIs in the image)".

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /repo

# ---- build: install all deps, build the agent + its workspace deps ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- runtime: generic runtimes only; real tools live on the /data volume ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production

# Generic runtimes ONLY (not specific CLIs):
#   python3        — runtime many CLIs need (e.g. gcloud); node is already here
#   curl, ca-certs — fetch tools + TLS during the one-time /data provisioning
#   git            — generic VCS; gh shells out to it (clone/checkout) and the
#                    agent uses it via run_cli. apt-based (not a static binary),
#                    so it belongs in the image, not on /data.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 git \
  && rm -rf /var/lib/apt/lists/*

# uv / uvx — generic Python tool runner (Astral). Some MCP servers ship as
# Python packages launched via `uvx <pkg>` (e.g. celery-flower-mcp). uv is a
# generic runtime like python3 (not a specific CLI), so it belongs in the image.
# Static binaries copied from the official uv image — no apt/curl needed. uvx
# caches downloaded packages + managed Pythons under HOME=/data/home, so the
# first-run fetch persists on the volume across redeploys.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# /data is the ONLY durable state: persistent CLIs / MCP servers + their auth +
# the OAuth store. Anything on /data/bin is on PATH, so volume-installed tools
# (gcloud, shopify-dev-mcp, gcloud-mcp, …) "just work" after a one-time setup —
# and survive redeploys because the volume persists. Provision once, never lose.
RUN mkdir -p /data/bin && chown -R node:node /data
ENV PATH="/data/bin:$PATH"

COPY --from=build --chown=node:node /repo /repo

# `sym` — the agent's OWN connector control-plane CLI (status/apply/mcp/secret +
# the interactive TUI). Unlike the third-party tools on /data, sym is first-party
# and belongs in the image. Expose it on PATH via a thin wrapper so, inside the
# container, `sym status` / `sym menu` "just work":
#     docker exec -it <container> sym status
#     docker exec -it <container> sym menu     # interactive TUI (needs -it)
RUN printf '#!/bin/sh\nexec node /repo/apps/agent/dist/cli/index.js "$@"\n' > /usr/local/bin/sym \
  && chmod +x /usr/local/bin/sym

USER node
WORKDIR /repo/apps/agent
# HOME on the /data volume — the key to PERSISTENT CLI AUTH. CLIs write their
# logins to $HOME/.config/… (gcloud, gh), ~/.netrc, ~/.sentryclirc, etc.; with
# HOME on /data those credentials survive redeploys with ZERO per-tool config.
# Tool-agnostic, and inherited by `docker exec` sessions too, so a login you do
# in the terminal is the same one the running agent uses. Created at boot (CMD)
# in case the volume is fresh.
ENV HOME=/data/home
# Persistent, node-writable defaults on the /data volume. Both the agent and the
# `sym` CLI (run via `docker exec`, which inherits these) resolve here — so the
# connector config + secret store survive redeploys and `sym` never falls back to
# a cwd-relative `.sym/` (which fails when run from `/`).
ENV SYM_DB_PATH=/data/credentials.db
ENV SYM_CONFIG_PATH=/data/sym/config.json
# AGENT_PORT (default 3001) — the HTTP server Slack + the OAuth callback reach.
EXPOSE 3001
# Ensure $HOME exists (fresh volume) before starting; `exec` keeps node as PID 1
# so SIGTERM still reaches it for graceful shutdown.
CMD ["sh", "-c", "mkdir -p \"$HOME\" && exec node dist/index.js"]
