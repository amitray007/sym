# Sym

An AI teammate that lives in a single team's Slack workspace, configured and
observed through its own dashboard. Joins channels, holds opinions, remembers
what matters, owns tasks, is accountable for everything it does.

> Status: built. Spine (Sp1–Sp4) and all streams (S1–S8), plus the agent and
> dashboard apps, are implemented, wired, and green (typecheck · lint · test ·
> build). The system runs end-to-end — see "Run it live" below.

## Repository layout

```
apps/                 Deployables — one folder per service
  agent/                Slack-side runtime (Hono + custom thin loop)        [S2/S1]
  dashboard/            Control plane (Next.js + Tailwind + shadcn + Clerk) [S3]

packages/             Workspace packages — @sym/* scope
  contracts/            Pure TypeScript types shared by all units           [Sp3]
  db/                   Drizzle schema + migrations                         [Sp2]
  secrets/              libsodium encrypt/decrypt + encryptedText column    [Sp4]
  kernel/               Thin agent loop                                     [S2]
  memory/               5-scope memory + retrieval gate                     [S7a]
  audit/                Hash-chained audit + receipts                       [S7b]
  tasks/                Durable queue + slice/checkpoint                    [S7c]
  soul/                 Cascade + tone-rewrite + substance-diff guard       [S7d]
  sandbox/              Docker + gVisor + egress proxy + leases             [S6]
  adapter/              Inbound surfaces (grouped; Slack-only in v1)
    slack/                Slack ingress + outbound + Block Kit              [S1]
  provider/             LLM providers (grouped; one impl per backend)
    fireworks/            Fireworks impl (OpenAI-compat)                    [S2]
  ext/                  Extensions (grouped)
    mcp/                  MCP HTTP + stdio + tool registry                  [S5]
    skills/               Skill loader + activation                         [S5]

docs/                 Specs, build plan, schema draft, blast-radius map
.claude/skills/       Discipline skills (cross-unit-impact, future)
```

> Package names keep a flat scope (`@sym/adapter-slack`, `@sym/provider-fireworks`)
> since npm package names can't nest; only the on-disk directories are grouped
> under `adapter/`, `provider/`, and `ext/`.

## Working model

Build is **dependency-ordered**, not phase- or calendar-based. Sequence and
parallelism are visualized in `docs/build-flow.md`. Per-stream end goals and
internal chunks are in `docs/implementation-ideology-plan.md`.

The **spine** (Sp1 → Sp4) must finish before any stream forks:

1. **Sp1** · Monorepo + tooling — _this chunk_
2. **Sp2** · `@sym/db` schema + migrations
3. **Sp3** · `@sym/contracts` (pure types)
4. **Sp4** · `@sym/secrets` (libsodium)

Then streams S1–S8 fork in parallel.

## Discipline

Every PR touching schema, `@sym/contracts`, or any shared interface runs the
checklist in `.claude/skills/cross-unit-impact/SKILL.md` and includes a
**Cross-unit impact** section in its description (the PR template enforces it
from PR #1).

## Getting started

Prerequisites: Node 24, pnpm 10, Postgres 16+ (native install), Redis 7+
(native install). See `docs/files-to-care-about.md` for sensitive surfaces.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### Run it live (local)

One-time bootstrap (assumes Postgres + Redis are installed and running — see
`scripts/setup-macos.sh` / `scripts/setup-linux.sh`):

```sh
sh scripts/dev-setup.sh   # creates sym_dev, writes .env + SYM_ENCRYPTION_KEY, migrates
```

Then fill the remaining secrets in `.env` (the bootstrap leaves these blank):

- **Clerk** — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (enable
  Google + Slack sign-in in the Clerk dashboard).
- **Slack app** — `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.
  Set the app's OAuth redirect URL to `${AGENT_URL}/slack/oauth/callback` and its
  Event request URL to the agent.
- **URLs** — `AGENT_URL` (default `http://localhost:3001`) and `DASHBOARD_URL`
  (default `http://localhost:3000`).
- **First admin** — `SYM_BOOTSTRAP_ADMIN_EMAILS=you@example.com` (your Clerk
  email). This is how you claim owner of a fresh instance.

> Do **not** run `pnpm db:seed` for a real Slack workspace — the seed inserts a
> fake workspace whose team id would block the real install (single-tenant).
> Seed only for dashboard-only dev without a real Slack connection.

Run both services:

```sh
pnpm dev            # agent on :3001, dashboard on :3000 (turbo, watch mode)
```

Open the dashboard, sign in with your allowlisted email, and walk the `/setup`
wizard: **Install** (Slack OAuth — creates the workspace and makes you owner on
return) → **Provider** (Fireworks API key + models) → **Access** (Slack ACL
mode). Once complete, DM or @mention the bot in Slack and it replies.

## License

MIT. Private OSS / internal use; not published to public npm. See `LICENSE`.

## Related docs

- `docs/specs/sym-overview-spec.md` — product thesis + v1 hard decisions
- `docs/implementation-ideology-plan.md` — how we build (spine + streams)
- `docs/build-flow.md` — visual dependency diagram
- `docs/db-schema-draft.md` — Sp2 schema review input
- `docs/files-to-care-about.md` — blast-radius map of files
- `.claude/skills/cross-unit-impact/SKILL.md` — the discipline applied on every PR
