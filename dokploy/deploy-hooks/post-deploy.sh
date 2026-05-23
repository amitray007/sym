#!/bin/sh
# dokploy/deploy-hooks/post-deploy.sh
#
# Smoke test: verify both apps are responding to /health after deployment.
#
# TODO(S3/S2): Enable this hook once apps/dashboard and apps/agent exist and
#              expose a /health endpoint. Until then this script exits 0 (no-op).
#
# To enable:
#   1. Set DASHBOARD_URL and AGENT_URL in Dokploy environment for both apps.
#   2. Remove the "exit 0" line below.
#
# Deploy order (for reference): DB migration → Dashboard → Agent → this check.

set -eu

log() { printf '[post-deploy] %s\n' "$*"; }
die() { printf '[post-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# ── TODO gate ─────────────────────────────────────────────────────────────────
# Remove this block once both apps exist and expose /health.
log "Smoke test is not yet active (apps/dashboard and apps/agent do not exist)."
log "TODO: remove the exit 0 below once both /health endpoints are live."
exit 0
# ─────────────────────────────────────────────────────────────────────────────

: "${DASHBOARD_URL:?DASHBOARD_URL must be set in Dokploy environment}"
: "${AGENT_URL:?AGENT_URL must be set in Dokploy environment}"

TIMEOUT=30

check_health() {
  app="$1"
  url="$2"
  log "Checking ${app} /health at ${url}/health …"
  i=0
  while [ "$i" -lt "$TIMEOUT" ]; do
    status=$(curl -sf -o /dev/null -w "%{http_code}" "${url}/health" 2>/dev/null || echo "000")
    if [ "$status" = "200" ]; then
      log "${app} /health OK (200)."
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  die "${app} /health did not return 200 within ${TIMEOUT}s (last status: ${status}). Deployment failed."
}

check_health "Dashboard" "$DASHBOARD_URL"
check_health "Agent"     "$AGENT_URL"

log "Smoke tests passed. Deployment complete."
