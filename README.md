# Sym

An AI teammate that lives in a single team's Slack workspace, configured and
observed through its own dashboard. Joins channels, holds opinions, remembers
what matters, owns tasks, is accountable for everything it does.

> Status: pre-implementation. The chassis (Sp1) is in place; spine and streams
> are being built per the build plan.

## Repository layout

```
apps/                 Deployables — one folder per service
  agent/                Slack-side runtime (Hono + custom thin loop)        [S2/S1]
  dashboard/            Control plane (Next.js + Tailwind + shadcn + Clerk) [S3]

packages/             Workspace packages — @sym/* scope
  contracts/            Pure TypeScript types shared by all units           [Sp3]
  db/                   Drizzle schema + migrations                         [Sp2]
  secrets/              libsodium encrypt/decrypt + encryptedText column    [Sp4]
  adapter-slack/        Slack ingress + outbound + Block Kit                [S1]
  kernel/               Thin agent loop                                     [S2]
  provider-fireworks/   Fireworks provider impl                             [S2]
  memory/               5-scope memory + retrieval gate                     [S7a]
  audit/                Hash-chained audit + receipts                       [S7b]
  tasks/                Durable queue + slice/checkpoint                    [S7c]
  soul/                 Cascade + tone-rewrite + substance-diff guard       [S7d]
  ext-mcp/              MCP HTTP + stdio + tool registry                    [S5]
  ext-skills/           Skill loader + activation                           [S5]
  sandbox/              Docker + gVisor + egress proxy + leases             [S6]

docs/                 Specs, build plan, schema draft, blast-radius map
.claude/skills/       Discipline skills (cross-unit-impact, future)
```

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

These all pass on the empty chassis. As packages land they wire into the
turbo pipeline automatically.

## License

MIT. Private OSS / internal use; not published to public npm. See `LICENSE`.

## Related docs

- `docs/specs/sym-overview-spec.md` — product thesis + v1 hard decisions
- `docs/implementation-ideology-plan.md` — how we build (spine + streams)
- `docs/build-flow.md` — visual dependency diagram
- `docs/db-schema-draft.md` — Sp2 schema review input
- `docs/files-to-care-about.md` — blast-radius map of files
- `.claude/skills/cross-unit-impact/SKILL.md` — the discipline applied on every PR
