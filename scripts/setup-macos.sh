#!/bin/sh
# scripts/setup-macos.sh
#
# Install native Postgres 16 and Redis 7 via Homebrew on macOS.
# Run once after cloning. Safe to re-run (idempotent).
#
# Usage:
#   sh scripts/setup-macos.sh
#
# After this script completes, run:
#   sh scripts/dev-setup.sh
#
# Requirements: macOS 12+, Homebrew installed (https://brew.sh)

set -eu

# ── helpers ──────────────────────────────────────────────────────────────────

log() { printf '\033[1;34m[setup-macos]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup-macos] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v brew >/dev/null 2>&1 || die "Homebrew not found. Install it first: https://brew.sh"

# ── Postgres 16 ──────────────────────────────────────────────────────────────

log "Installing postgresql@16 …"
brew install postgresql@16 || true

PG_BIN="$(brew --prefix postgresql@16)/bin"
export PATH="$PG_BIN:$PATH"

# Link pg_ctl etc into PATH if not already linked.
brew link --force postgresql@16 2>/dev/null || true

log "Starting postgresql@16 service …"
brew services start postgresql@16

# Wait up to 15 s for Postgres to accept connections.
i=0
while ! "$PG_BIN/pg_isready" -q 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then
    die "Postgres did not become ready in 15 s. Check: brew services list"
  fi
  sleep 1
done
log "Postgres is ready."

# ── Redis 7 ──────────────────────────────────────────────────────────────────

log "Installing redis …"
brew install redis || true

log "Starting redis service …"
brew services start redis

# Quick ping check.
i=0
while ! redis-cli ping >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 10 ]; then
    die "Redis did not become ready in 10 s. Check: brew services list"
  fi
  sleep 1
done
log "Redis is ready."

# ── done ─────────────────────────────────────────────────────────────────────

log "macOS services installed and running."
log "Next step: sh scripts/dev-setup.sh"
