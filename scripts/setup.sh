#!/bin/sh
# scripts/setup.sh
#
# One-time dev bootstrap. Safe to re-run (idempotent).
#
# Requirements: Node 24 (see .nvmrc), pnpm 10 (corepack enable)
#
# Usage:
#   sh scripts/setup.sh

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── sanity checks ─────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || die "node not found. Install Node 24 (see .nvmrc / corepack enable)."
command -v pnpm >/dev/null 2>&1 || die "pnpm not found. Run: corepack enable"

# ── install dependencies ──────────────────────────────────────────────────────

log "Installing pnpm dependencies …"
pnpm install --dir "${REPO_ROOT}"

# ── generate .env ─────────────────────────────────────────────────────────────

ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"

if [ -f "${ENV_FILE}" ]; then
  log ".env already exists — skipping (delete it to regenerate)."
else
  log "Creating .env from .env.example …"
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  log ".env created. Fill in the required values before running the agent."
fi

# ── done ─────────────────────────────────────────────────────────────────────

log ""
log "Setup complete. Next steps:"
log "  1. Edit .env and fill in all required variables (see README)."
log "  2. pnpm --filter @sym/agent dev"
