# Contributing to Sym

Questions → [GitHub Discussions](https://github.com/amitray007/sym/discussions) or the issue tracker.
Bug reports → use the [Bug Report issue template](https://github.com/amitray007/sym/issues/new?template=bug_report.yml).
Feature ideas → open a Discussion first. PRs without a linked Discussion may be closed.

---

## Prerequisites

- **Node >= 24** — the repo ships an `.nvmrc`; `nvm use` or `fnm use` selects the right version automatically.
- **pnpm >= 10** — installed via Corepack: `corepack enable && corepack install`.
- **Git hooks** — installed by `scripts/setup.sh` (commitlint + lint-staged).

```sh
# One-time setup after cloning
bash scripts/setup.sh
```

---

## Development loop

```sh
# Install all workspace dependencies
pnpm install

# Build all packages (required before running the agent or tests)
pnpm build

# Start the agent in watch mode (hot-reloads on file changes)
pnpm --filter @sym/agent dev

# Run unit tests across all packages
pnpm test

# Run real-wire integration tests (MCP + HTTP — no Slack required)
pnpm test:integration

# Type-check every package
pnpm typecheck

# Lint + prettier check
pnpm lint
```

The agent listens on `http://localhost:3001` (or `$AGENT_PORT`). You need a
tunnel (e.g. `ngrok http 3001`) and a Slack app to receive events locally — see
the [Quick start](README.md#quick-start) in the README.

> **Never start the dev server yourself in a script or test.** The user runs
> `pnpm --filter @sym/agent dev` in their own terminal. Tests use ephemeral
> in-process servers.

---

## The full gate (run before pushing)

CI runs these in order; every step must be green before a PR can merge:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build
```

The CI also enforces:

- **No `console.log` outside `cli/`** — server code uses `console.info`/`.warn`/`.error` only.
- **No circular dependencies** (dependency-cruiser).
- **No broken imports across package boundaries** (the `contracts → kernel / adapter-slack → agent` DAG is enforced).

---

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) are enforced by
commitlint. Format: `<type>(<scope>): <description>`

Valid scopes (from `.commitlintrc.cjs`):

| Scope           | What it covers                          |
| --------------- | --------------------------------------- |
| `agent`         | `apps/agent` — the Hono server          |
| `slack`         | Slack event handling, guard, owner gate |
| `mcp`           | MCP connector pool, config, OAuth store |
| `pi`            | Pi agent loop                           |
| `tools`         | Built-in tool handlers                  |
| `tui`           | Ink/React operator dashboard            |
| `cli`           | `sym` operator CLI                      |
| `contracts`     | `packages/contracts` — shared types     |
| `kernel`        | `packages/kernel` — prompt assembly     |
| `adapter-slack` | `packages/adapter/slack` — Slack client |
| `build`         | Build system, Turbo, Dockerfile         |
| `ci`            | GitHub Actions workflows                |
| `deps`          | Dependency updates                      |
| `docs`          | Documentation                           |
| `config`        | Root config files                       |

Common types: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `build`, `ci`.

---

## Tests convention

- Unit tests live in `tests/` inside each package (e.g.
  `apps/agent/tests/`, `packages/kernel/tests/`), not co-located with source.
- Integration tests (real-wire, no mocks) are also in `tests/` and run via
  `pnpm test:integration`.
- Every test file imports from `vitest` explicitly — no `globals: true`.

---

## Cross-unit impact

Sym is a monorepo with a strict package DAG. Before changing any interface in
`packages/contracts`, `packages/kernel`, or `packages/adapter/slack`, run the
cross-unit impact checklist (`.claude/skills/cross-unit-impact/SKILL.md`).
Name every consumer, confirm backward-compatibility, and document the rollback
plan in the PR.

---

## Pull request process

1. Open a Discussion for non-trivial features before writing code.
2. Keep PRs focused — one logical change per PR.
3. Fill in the PR template fully (summary, what changed, verification steps).
4. All CI checks must pass before review.
5. At least one maintainer approval is required to merge.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the codemap and invariants before
making structural changes.
