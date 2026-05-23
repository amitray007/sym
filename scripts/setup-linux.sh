#!/bin/sh
# scripts/setup-linux.sh
#
# Install native Postgres 16 and Redis 7 via apt on Debian/Ubuntu.
# Run once after cloning. Safe to re-run (idempotent).
#
# Usage (requires sudo):
#   sh scripts/setup-linux.sh
#
# After this script completes, run:
#   sh scripts/dev-setup.sh
#
# Requirements: Debian 11+ / Ubuntu 22.04+

set -eu

# ── helpers ──────────────────────────────────────────────────────────────────

log() { printf '\033[1;34m[setup-linux]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup-linux] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v apt-get >/dev/null 2>&1 || die "apt-get not found; this script targets Debian/Ubuntu only."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "sudo not found and not running as root."
  SUDO="sudo"
fi

# ── Postgres 16 ──────────────────────────────────────────────────────────────

log "Adding pgdg apt repository …"
$SUDO apt-get install -y curl ca-certificates gnupg lsb-release

# Official PostgreSQL Global Development Group (PGDG) apt repo.
PGDG_KEY=/etc/apt/trusted.gpg.d/pgdg.gpg
if [ ! -f "$PGDG_KEY" ]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | $SUDO gpg --dearmor -o "$PGDG_KEY"
fi

CODENAME=$(lsb_release -cs 2>/dev/null || echo "jammy")
PGDG_LIST=/etc/apt/sources.list.d/pgdg.list
if [ ! -f "$PGDG_LIST" ]; then
  echo "deb https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    | $SUDO tee "$PGDG_LIST" >/dev/null
fi

$SUDO apt-get update -qq
log "Installing postgresql-16 …"
$SUDO apt-get install -y postgresql-16 postgresql-client-16

log "Enabling and starting postgresql service …"
$SUDO systemctl enable postgresql
$SUDO systemctl start postgresql

# Wait up to 15 s.
i=0
while ! pg_isready -q 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then
    die "Postgres did not become ready in 15 s."
  fi
  sleep 1
done
log "Postgres is ready."

# ── Redis 7 ──────────────────────────────────────────────────────────────────

# Add Redis official apt repo for a recent stable release.
REDIS_KEY=/etc/apt/trusted.gpg.d/redis.gpg
if [ ! -f "$REDIS_KEY" ]; then
  curl -fsSL https://packages.redis.io/gpg \
    | $SUDO gpg --dearmor -o "$REDIS_KEY"
fi

REDIS_LIST=/etc/apt/sources.list.d/redis.list
if [ ! -f "$REDIS_LIST" ]; then
  echo "deb https://packages.redis.io/deb ${CODENAME} main" \
    | $SUDO tee "$REDIS_LIST" >/dev/null
fi

$SUDO apt-get update -qq
log "Installing redis-server …"
$SUDO apt-get install -y redis-server

log "Enabling and starting redis service …"
$SUDO systemctl enable redis-server
$SUDO systemctl start redis-server

# Quick ping check.
i=0
while ! redis-cli ping >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 10 ]; then
    die "Redis did not become ready in 10 s."
  fi
  sleep 1
done
log "Redis is ready."

# ── done ─────────────────────────────────────────────────────────────────────

log "Linux services installed and running."
log "Next step: sh scripts/dev-setup.sh"
