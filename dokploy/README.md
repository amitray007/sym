# Dokploy deployment configuration

Sym runs two deployables on one Dokploy VPS:

| Deployable  | Source           | Port | Framework |
| ----------- | ---------------- | ---- | --------- |
| `dashboard` | `apps/dashboard` | 3000 | Next.js   |
| `agent`     | `apps/agent`     | 3001 | Hono      |

Both share a single Postgres 16 instance and a single Redis 7 instance,
installed natively on the VPS (not in Docker).

## Enforced deploy order

Every production deploy MUST follow this order. Violating it risks serving
new code against an old schema:

```
1. DB migration   pnpm db:migrate   (run once, blocks Dashboard + Agent)
2. Dashboard      deploy dashboard  (reads new schema, Clerk-gated)
3. Agent          deploy agent      (reads new schema, serves Slack traffic)
```

This order is documented here and enforced by the Dokploy pipeline hooks
(see `deploy-hooks/`). Any PR that changes the schema MUST include a
"Deploy order" entry in its Cross-unit impact section.

## Rollback discipline

Every deploy must be rollback-safe:

- Schema changes are additive until both services are stable (expand-contract).
- `NOT NULL` columns only after backfill completes.
- Indexes created `CONCURRENTLY`.
- If a deploy cannot be rolled back without data loss, it must not ship.

See `.claude/skills/cross-unit-impact/SKILL.md` for the full discipline.

## Files in this directory

| File                          | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `env-template.txt`            | Env var placeholders to paste into Dokploy secrets UI  |
| `deploy-hooks/pre-deploy.sh`  | Runs `pnpm db:migrate` before any app deploys          |
| `deploy-hooks/post-deploy.sh` | Smoke-test stub; enabled once both apps exist          |
| `apps/dashboard.yml`          | Dokploy app config skeleton (TODO — app not yet built) |
| `apps/agent.yml`              | Dokploy app config skeleton (TODO — app not yet built) |

## TODO items (unblock as apps land)

- [ ] `apps/dashboard`: create `apps/dashboard/Dockerfile` (Next.js standalone build)
- [ ] `apps/agent`: create `apps/agent/Dockerfile` (Hono Bun/Node build)
- [ ] Fill `apps/dashboard.yml` and `apps/agent.yml` with real build + start commands
- [ ] Enable `post-deploy.sh` smoke test once both `/health` endpoints exist
- [ ] Configure Dokploy webhook secrets in GitHub Actions secrets:
      `DOKPLOY_WEBHOOK_URL_DASHBOARD` and `DOKPLOY_WEBHOOK_URL_AGENT`
