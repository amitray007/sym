# syntax=docker/dockerfile:1
#
# Sym agent — production image (single deployable).
# pnpm + turbo monorepo: builds apps/agent and its workspace deps
# (@sym/kernel, @sym/contracts, @sym/adapter-slack), then runs the agent.
#
# This image is deliberately CLI-AGNOSTIC. It bakes in only GENERIC runtimes
# (node, python3, curl) — never a specific CLI. The actual tools you connect —
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
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 \
  && rm -rf /var/lib/apt/lists/*

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
ENV SYM_DB_PATH=/data/credentials.db
# AGENT_PORT (default 3001) — the HTTP server Slack + the OAuth callback reach.
EXPOSE 3001
CMD ["node", "dist/index.js"]
