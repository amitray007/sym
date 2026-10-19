# 019. Container image and API token

Status: accepted
Date: 2026-10-20

## Context

Sym must run on any Docker host, with Dokploy as the reference. The scaffold route auth used
`placeholderAuth()`, which rejects every production request. Scripts, CI, and operators need a
way to call the Eve session routes. Sym has `defaultTools: false` and no sandbox, so the full
`eve build` image pull adds nothing (decision 013).

## Decision

The `Dockerfile` has three stages on Node 24. The build stage installs all dependencies with
`pnpm install --frozen-lockfile` and runs `pnpm build:compile`. The dependency stage installs
production dependencies only. The runtime stage holds `.output`, `.eve`, `agent/`, `lib/`, and
`scripts/migrate.ts`, runs as the `node` user, exposes port 3000, and declares a volume at
`.eve/.workflow-data`. The start command applies ledger migrations and then runs `eve start`.
The image holds no secrets.

Route auth on the Eve channel has two entries. The first accepts `Authorization: Bearer
<SYM_API_TOKEN>` and compares in constant time. If `SYM_API_TOKEN` is unset, it accepts nothing.
The second is `localDev()`, which works only under `eve dev`. Sym drops `vercelOidc()` and
`placeholderAuth()`. The health route stays public.

## Consequences

Without `SYM_API_TOKEN`, production rejects every session request with 401, so the owner must
set it. One token gives full operator access, so the owner keeps it secret and rotates it by
changing the variable and restarting. The runtime stage needs `agent/` and `lib/` as source,
because Eve rebuilds route auth from the authored channel at boot and migrations run from
TypeScript. Image changes follow the lockfile, so the owner upgrades Eve only with no running jobs.
