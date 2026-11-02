# syntax=docker/dockerfile:1
# Sym image. Build: docker build -t sym:local .   Secrets come from the environment at run time.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS base
ENV CI=true
# Enable the pnpm version that package.json pins in "packageManager".
RUN corepack enable
WORKDIR /app

# Optional pack. `docker build --build-context pack=<pack-dir> .` applies the pack overlay (instructions
# and playbooks) before the Eve build. Without the flag this stage is empty and the build adds nothing.
FROM scratch AS pack

# The docker CLI, for the sandbox (decision 089). Sym runs sandbox containers through the host's
# Docker daemon when compose.yaml mounts its socket. Without the socket the sandbox stays off.
FROM docker:29.4.0-cli AS docker-cli

# Build stage: all dependencies, then the full Eve build. It records the sandbox artifact that
# `eve start` needs. Sym's Docker provider builds no template image, so this step needs no Docker
# daemon (decision 089).
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN --mount=type=bind,from=pack,target=/pack \
    if [ -f /pack/sym.config.yaml ]; then node scripts/pack-overlay.ts /pack /app; fi
RUN pnpm build

# Dependency stage: production dependencies only.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/.eve ./.eve
COPY package.json tsconfig.json ./
# From the build stage, so the pack overlay files come along.
COPY --from=build /app/agent ./agent
COPY lib ./lib
COPY scripts/migrate.ts ./scripts/migrate.ts
# Workflow state lives in .eve/.workflow-data. Mount a persistent volume there.
RUN mkdir -p .eve/.workflow-data && chown -R node:node /app/.eve
USER node
VOLUME ["/app/.eve/.workflow-data"]
EXPOSE 3000
# Apply ledger migrations, then start Eve (which also runs the scheduler). Run one replica.
CMD ["sh", "-c", "node scripts/migrate.ts && exec ./node_modules/.bin/eve start --host 0.0.0.0"]
