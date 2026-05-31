# syntax=docker/dockerfile:1
#
# Sym agent — production image (single deployable).
# pnpm + turbo monorepo: builds apps/agent and its workspace deps
# (@sym/kernel, @sym/contracts, @sym/adapter-slack), then runs the agent.
#
# Connectors that shell out to a CLI need that CLI present in this image:
#   - npx-based stdio MCP servers (shopify, sentry, notion, influxdb, gcloud-mcp):
#     npx ships with node — already available.
#   - uvx-based (Python) MCP servers (mcp-google-sheets, celery-flower-mcp):
#     uncomment the `uv` install block in the runtime stage.
#   - ambient gcloud (Model B): also install the gcloud CLI, and mount a
#     persistent volume at /data (CLOUDSDK_CONFIG=/data/gcloud) for its login.

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /repo

# ---- build: install all deps, build the agent + its workspace deps ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- runtime: node only; run the built agent ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production

# Uncomment if you use uvx-based (Python) MCP servers:
# RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
#   && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
#   && rm -rf /var/lib/apt/lists/*

# /data is the ONLY durable state: the OAuth token store (SYM_DB_PATH) and any
# ambient CLI config dirs (Model B). Mount a persistent volume here in prod.
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /repo /repo

USER node
WORKDIR /repo/apps/agent
ENV SYM_DB_PATH=/data/credentials.db
# AGENT_PORT (default 3001) — the HTTP server Slack + the OAuth callback reach.
EXPOSE 3001
CMD ["node", "dist/index.js"]
