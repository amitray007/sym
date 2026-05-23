#!/bin/sh
# dokploy/deploy-hooks/pre-deploy.sh
#
# Runs BEFORE any Dokploy app deployment.
# Enforces the mandatory deploy order: DB migration → Dashboard → Agent.
#
# Configure this as the "Pre-deploy hook" in Dokploy for both apps.
# DATABASE_URL must be set in the Dokploy environment for this deployable.
#
# Deploy order (MUST NOT be changed without a cross-unit impact review):
#   1. This script: pnpm db:migrate
#   2. Dashboard deployment
#   3. Agent deployment

set -eu

log() { printf '[pre-deploy] %s\n' "$*"; }
die() { printf '[pre-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL must be set in Dokploy environment}"

log "Running DB migrations before app deployment …"
log "Deploy order: DB migration (this step) → Dashboard → Agent"

# Run migrations from the repo root. Dokploy clones the repo before hooks.
pnpm db:migrate

log "Migrations complete. Proceeding to app deployment."
