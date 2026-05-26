#!/bin/sh
# dokploy/deploy-hooks/post-deploy.sh
#
# Smoke test: verify the agent is responding to /health after deployment.
#
# Set AGENT_URL in the Dokploy environment to enable this check.

set -eu

log() { printf '[post-deploy] %s\n' "$*"; }
die() { printf '[post-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

: "${AGENT_URL:?AGENT_URL must be set in Dokploy environment}"

TIMEOUT=30

log "Checking agent /health at ${AGENT_URL}/health …"
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  status=$(curl -sf -o /dev/null -w "%{http_code}" "${AGENT_URL}/health" 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    log "Agent /health OK (200)."
    log "Smoke test passed. Deployment complete."
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

die "Agent /health did not return 200 within ${TIMEOUT}s (last status: ${status}). Deployment failed."
