# Files to Take Care About

## Metadata

- Created: 2026-05-23
- Last Edited: 2026-05-23
- Status: **Active · living reference**
- Owner: Sym authors

## Changelog

- 2026-05-23: Initial version. Tiered by blast radius (0 = reference,
  1 = constitutional, 2 = high-discipline, 3 = sensitive operational,
  4 = per-stream ownership, 5 = discipline/memory). "Never create" list
  at the bottom for shape-of-Sym anti-patterns.

---

## Intent

A blast-radius map of every file (and category of file) that matters in
Sym. The lower the tier number, the more care needed when touched.

Use this:
- Before editing — find the file's tier, apply the right level of review.
- During code review — verify the PR's care matches the tier touched.
- When onboarding — read top-down to learn what the system's
  load-bearing surfaces are.

Living document. Add rows when new constitutional files emerge, when a
near-miss teaches us a new high-discipline path, or when a new sensitive
operational item appears.

---

## Tier 0 — Reference files that exist today (don't drift from these)

| File | What it is | When you touch it |
|---|---|---|
| `docs/specs/sym-overview-spec.md` | Product thesis + locked architectural decisions | Only to record a v2-class reversal |
| `docs/specs/security-policy.md` | Security invariants | Only with security review |
| `docs/specs/AGENTS.md` | Spec conventions | Rarely; meta |
| `docs/specs/chat-architecture-spec.md` and other adapted-from-Junior specs | Reference contracts (study, adapt) | Read often; edit when **our** behavior diverges from upstream — mark as Sym delta |
| `docs/implementation-ideology-plan.md` | How we build (chunks, streams, sequencing) | Update as the build teaches us things |
| `docs/db-schema-draft.md` | Sp2 schema input for review | Edit during review; freeze after lock; thereafter changes are in migrations, not here |
| `docs/files-to-care-about.md` | This document | Add rows as the system grows |
| `.claude/skills/cross-unit-impact/SKILL.md` | The discipline applied on every PR | Improve after every near-miss |

---

## Tier 1 — Constitutional (touch with full review; broadest blast radius)

Don't exist yet — will. Every PR touching them runs the full
cross-unit-impact checklist; ideally two reviewers.

| File / path | Why it's constitutional |
|---|---|
| `packages/db/src/schema/*` | The lingua franca. Every stream reads/writes through here |
| `packages/db/migrations/*` | The actual production change. Schema-change subroutine mandatory |
| `packages/contracts/src/*` | TypeScript types every other package depends on; single designated owner-merger |
| `pnpm-workspace.yaml` | Workspace topology; affects every package resolution |
| `turbo.json` | Build pipeline; affects CI + local dev |
| `tsconfig.base.json` | Type semantics for everything |
| `.github/pull_request_template.md` | The discipline gate; ships in PR #1 |
| `.github/workflows/ci.yml` | The safety net; every PR runs against it |
| `Dockerfile`s for `apps/agent`, `apps/dashboard`, `packages/sandbox/Dockerfile.sandbox-base` | Production image surface; security-relevant |
| `drizzle.config.ts` | Where the migration tool reads schema from |

---

## Tier 2 — High-discipline (cross-unit checklist required when changed)

Touched often, but with care. Run the checklist; PR description carries
the impact section.

- Any package's `src/index.ts` (the public API)
- Provider interface implementations: `packages/provider/fireworks/src/provider.ts` and any future provider
- The retrieval gate: `packages/memory/src/retrieval-gate.ts`
- The egress proxy: `packages/sandbox/src/proxy/server.ts` + `lease-store.ts`
- JWT minter + verifier: `packages/sandbox/src/jwt-minter.ts`
- Audit append primitive: `packages/audit/src/append.ts` + `hash-chain.ts`
- Change-policy classifier: `packages/memory/src/change-policy.ts`
- Substance-diff guard: `packages/soul/src/substance-diff.ts`
- Slack OAuth handler: `apps/agent/src/routes/slack/oauth.ts`
- Clerk middleware: `apps/dashboard/middleware.ts`

---

## Tier 3 — Sensitive operational files (production correctness rides on these)

| File / item | Care |
|---|---|
| `.env` (any env file) | **Never committed.** Gitignored from day 1. Dokploy injects in prod |
| `.env.example` | Template only; never holds real values; reviewed when adding required vars |
| `SYM_ENCRYPTION_KEY` (env var) | 32-byte base64, off-disk handling; loss = irrecoverable token corruption |
| Clerk publishable + secret keys | Per-env; Clerk dashboard is the source of truth |
| Slack signing secret + client secret | Per-env; rotate after staff offboarding |
| Fireworks API key | Stored encrypted in `provider_configs.api_key`, not in env (per-workspace) |
| Dokploy deploy config | Production deploy choreography; deploy ordering enforced here |
| `apps/agent/Dockerfile`, sandbox base image | Build inputs; vulnerability surface; pinned base images, periodic rebuilds |
| Postgres `pg_hba.conf` + Redis `redis.conf` | Host-level; restrict to localhost + app user |
| Backup / PITR setup (out of repo) | Tracked under S8; loss-of-data risk |

---

## Tier 4 — Per-stream ownership map

When a stream is "in progress," its owner is the authority on these
files; cross-stream changes here trigger the discipline.

| Stream | Owns these paths |
|---|---|
| **Sp1** chassis | Root configs: `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.husky/`, `.editorconfig`, `.nvmrc`, `package.json` (root), `.gitignore`, `LICENSE`, `README.md` |
| **Sp2** db | `packages/db/**`, `drizzle.config.ts` |
| **Sp3** contracts | `packages/contracts/**` |
| **Sp4** secrets | `packages/secrets/**` |
| **S1** Slack adapter | `packages/adapter/slack/**`, `apps/agent/src/routes/slack/**` |
| **S2** kernel + Fireworks | `packages/kernel/**`, `packages/provider/fireworks/**` |
| **S3** dashboard shell | `apps/dashboard/**` (layout, auth, nav, layout shell) |
| **S4** first-time settings | `apps/dashboard/app/(onboarding)/**` and wizard-specific routes |
| **S5** MCP + skills | `packages/ext/mcp/**`, `packages/ext/skills/**` |
| **S6** sandbox + egress | `packages/sandbox/**`, sandbox base Dockerfile |
| **S7a** memory | `packages/memory/**` + `packages/memory/evals/**` |
| **S7b** audit + receipts | `packages/audit/**` |
| **S7c** tasks | `packages/tasks/**` |
| **S7d** soul + tone | `packages/soul/**`, `sym.soul.md` (L0), `packages/soul/evals/**` |
| **S8** DevEx / CI / deploy | `.github/**`, `scripts/**`, `dokploy/**`, `docker-compose.yml`, `Dockerfile`s, `.env.example` files |

---

## Tier 5 — Discipline + memory (the agent layer)

| File | Purpose |
|---|---|
| `.claude/skills/cross-unit-impact/SKILL.md` | The migration / contract / deploy discipline |
| `.claude/skills/<future>/SKILL.md` | New skills as patterns emerge (likely: schema-review, eval-driven-classifier, slack-oauth-flow) |
| Project memory under `~/.claude/projects/-Users-maverick-code-projects-sym/memory/` | What past sessions learned about Sym; survives across conversations |

---

## Files that should never be created

| Don't create | Why |
|---|---|
| `*.yaml` config files for skills / MCPs / soul | Config lives in Postgres (config-as-database) |
| A second adapter package (`adapter-discord`, `adapter-teams`, etc.) | Slack-only commitment per overview spec |
| A `pi-client` / `vercel-ai-sdk` dependency | We have a custom thin loop directly on the provider SDK |
| `app/api/internal-rpc/*` routes between Dashboard and Agent | They share Postgres; no app-to-app RPC layer |
| Per-feature flag systems (LaunchDarkly etc.) | Dashboard toggles + DB rows do the job; flags add complexity we don't need yet |
| Custom session middleware in the Dashboard | Clerk handles sessions (per D1) |
| `admin_sessions` table | Clerk handles sessions (per D1) |

---

## How tier choice maps to PR review intensity

| Tier | Review bar | Reviewers | Discipline applied |
|---|---|---|---|
| 0 | Edit with intent; align with existing prose | 1 reviewer (the document owner) | Spec hygiene per `docs/specs/AGENTS.md` |
| 1 | Full cross-unit checklist; PR impact section mandatory | 2 reviewers (incl. constitutional owner) | `cross-unit-impact` skill, full pass |
| 2 | Cross-unit checklist; PR impact section mandatory | 1 reviewer (stream owner) + 1 affected stream | `cross-unit-impact` skill, full pass |
| 3 | Security-leaning review; rotation plan if touching secrets | 1 reviewer + security-aware second pair of eyes | Verify no secret leaks into logs, history, image layers |
| 4 | Stream owner is the authority; downstream impact noted if it crosses | 1 reviewer (stream owner) | Run `cross-unit-impact` if change affects another stream |
| 5 | Improve the skill / memory; commit, then live with the change | 1 reviewer | Note the lesson that triggered the change |

---

## Related

- `docs/implementation-ideology-plan.md` — the build flow that defines streams S1–S8
- `docs/db-schema-draft.md` — the schema that lives in Tier 1
- `.claude/skills/cross-unit-impact/SKILL.md` — the discipline referenced throughout
- `docs/specs/sym-overview-spec.md` — the overview that grounds the "files that should never be created" list
