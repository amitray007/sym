#!/bin/sh
# dokploy/deploy-hooks/pre-deploy.sh
#
# Runs BEFORE the agent deployment.
# No DB migration needed — the agent is configured entirely by env.
#
# no-op

set -eu

log() { printf '[pre-deploy] %s\n' "$*"; }

log "No pre-deploy steps required. Proceeding to deployment."
