# Sym

Sym is a generic, self-hosted, open-source Slack agent. Eve is the brain. Workers, starting with
T3 Code, do the work in repositories. Read `docs/README.md` and the documents it lists before
planning or building anything.

## Invariants

- Keep the code, docs, examples, and mockups generic. Do not name any company, team, customer, or
  private repository. Adopter specifics belong in a pack (`docs/adopting.md`).
- The Postgres ledger is the source of truth. Eve sessions are disposable. A job must continue
  after its session dies.
- Every Slack post goes through `chooseDisplay` in `lib/display.ts`. The outbox refuses a post
  without a display choice.
- Sym never edits repositories itself. Workers do, through an adapter.
- A job that can write code, data, or settings needs an approval until the owner promotes its job
  class on the trust ladder. Briefs keep production and customer data read-only unless the owner
  grants a write.
- Learned behavior is text, rows, or code under review. Layer 2 rows load only after approval.
  Layer 3 changes arrive as draft PRs.
- Secrets live in the deployment environment. Never commit them, log them, or put them in a pack.
  Never log or screenshot a pairing URL or authorization code.

## Documentation

`docs/README.md` indexes every design document. Keep the docs current as part of each change:

- Record each decision in `docs/decisions/NNN-<slug>.md` and add it to `docs/decisions/README.md`.
- Update the design document that the decision changes.
- Keep `docs/mockups/index.html` in step with the Slack design. It is a self-contained page.

## Status

Milestone 1 is in progress (`docs/milestone-1.md`). Done: the Eve scaffold, tooling, CI, local
Postgres, the ledger, and `chooseDisplay` with unit tests. Code done, live check pending: the T3
adapter, the `t3_job` tool, and the Slack channel. Next: the live checks, then the job card and
worker questions.

## Commands

Node 24 and pnpm, pinned in `mise.toml`. Run tools through mise, for example
`mise exec -- pnpm test`.

- `pnpm install`
- `pnpm lint` (Biome), `pnpm typecheck` (tsc), `pnpm test` (Vitest), `pnpm knip`
- `pnpm build:compile` compiles the agent without sandbox preparation. CI runs it.
- `pnpm build` is the full `eve build` for deploy images. It pulls Eve's sandbox image.
- `pnpm dev` starts `eve dev` with the terminal UI. Agents use `pnpm exec eve dev --no-ui` in a
  background process, then stop it after the check.
- `pnpm eval` runs `eve eval`.
- `pnpm db:up` starts Postgres 18 from `compose.yaml` on `127.0.0.1:55432`. `pnpm db:down` stops
  it. Ledger tests need it and `DATABASE_URL=postgres://sym:sym@localhost:55432/sym`.
- `pnpm db:migrate` applies pending ledger migrations (`lib/ledger/migrations.ts`).
- `pnpm t3:login <mcp-url>` signs Sym in to a T3 worker and saves the token to `.env.local`. The
  owner approves in the browser. `pnpm t3:check` lists the worker's projects and providers.
- `pnpm t3:job-smoke <project>` runs the job steps live without Eve. It launches a real worker
  thread, so use a throwaway project.

Local secrets go in `.env.local` (gitignored). `.env.example` lists the variables. Agents never
read `.env.local`.

Tests use fakes and never call a real worker, the real Slack API, or a paid model. Ledger tests
use a real Postgres (decision 014).

## Code layout

| Folder | Owns |
|---|---|
| `agent/` | The Eve agent: `agent.ts`, instructions, channels, tools, schedules, hooks, skills |
| `lib/` | Sym modules the agent imports: the display rule, the database client, worker adapters, and the ledger |
| `scripts/` | Operator scripts run with `node`, such as the T3 sign-in and check |
| `test/` | Vitest tests. `test/fakes/` holds the fake worker. `test/helpers/` gives each ledger test file its own schema |
| `slack/` | Slack app manifest |
| `docs/` | Design documents, decisions, and mockups |

## Git

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`).
