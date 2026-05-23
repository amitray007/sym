#!/bin/sh
# scripts/dev-setup.sh
#
# One-time dev environment bootstrap:
#   1. Creates the sym_dev Postgres database (idempotent).
#   2. Generates a .env from .env.example if .env does not exist.
#   3. Generates a SYM_ENCRYPTION_KEY and writes it into .env.
#   4. Runs pnpm db:migrate to prime the schema.
#
# Run AFTER setup-macos.sh or setup-linux.sh (Postgres + Redis must be up).
#
# Usage:
#   sh scripts/dev-setup.sh
#
# Re-running is safe: existing .env is never overwritten.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\033[1;34m[dev-setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[dev-setup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── sanity checks ────────────────────────────────────────────────────────────

command -v psql >/dev/null 2>&1   || die "psql not found. Run setup-macos.sh or setup-linux.sh first."
command -v redis-cli >/dev/null 2>&1 || die "redis-cli not found. Run setup-macos.sh or setup-linux.sh first."
command -v pnpm >/dev/null 2>&1   || die "pnpm not found. Install it via: corepack enable"
command -v node >/dev/null 2>&1   || die "node not found. Install Node 24 (see .nvmrc)."

pg_isready -q 2>/dev/null || die "Postgres is not running. Start it first (brew services start postgresql@16 / systemctl start postgresql)."
redis-cli ping >/dev/null 2>&1   || die "Redis is not running. Start it first."

# ── create sym_dev database ──────────────────────────────────────────────────

log "Creating sym_dev database (idempotent) …"
# createdb exits 1 if the DB already exists; the || true makes it idempotent.
createdb sym_dev 2>/dev/null || true
log "sym_dev database ready."

# ── generate .env ─────────────────────────────────────────────────────────────

ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

if [ -f "$ENV_FILE" ]; then
  log ".env already exists — skipping generation (delete it to regenerate)."
else
  log "Generating .env from .env.example …"
  cp "$ENV_EXAMPLE" "$ENV_FILE"

  # Generate a fresh SYM_ENCRYPTION_KEY (32 random bytes, base64).
  KEY=$(node -e "
    const { randomBytes } = await import('node:crypto');
    process.stdout.write(randomBytes(32).toString('base64'));
  " --input-type=module 2>/dev/null)

  # Replace the empty SYM_ENCRYPTION_KEY= line in .env.
  # Use portable sed: -i '' on macOS, -i on Linux.
  case "$(uname -s)" in
    Darwin) sed -i '' "s|^SYM_ENCRYPTION_KEY=\$|SYM_ENCRYPTION_KEY=$KEY|" "$ENV_FILE" ;;
    *)      sed -i    "s|^SYM_ENCRYPTION_KEY=\$|SYM_ENCRYPTION_KEY=$KEY|" "$ENV_FILE" ;;
  esac

  log ".env written with a generated SYM_ENCRYPTION_KEY."
  log "Keep .env out of git (it is .gitignore'd) and back up the key off-disk."
fi

# ── install node dependencies ─────────────────────────────────────────────────

log "Installing pnpm dependencies …"
cd "$REPO_ROOT"
pnpm install

# ── run DB migrations ─────────────────────────────────────────────────────────

log "Running DB migrations (pnpm db:migrate) …"
pnpm db:migrate

# ── done ─────────────────────────────────────────────────────────────────────

log ""
log "Dev environment ready."
log "  Postgres : ${DATABASE_URL:-postgres://localhost:5432/sym_dev}"
log "  Redis    : ${REDIS_URL:-redis://localhost:6379}"
log ""
log "Start developing:"
log "  pnpm dev            — run all packages in watch mode"
log "  pnpm test           — run full test suite"
log "  pnpm db:studio      — open Drizzle Studio"
