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
  class on the trust ladder. Briefs keep production and customer data read-only. A job can
  prepare a production change; a person runs it (decision 064).
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

Milestone 1 is in progress (`docs/milestone-1.md`). Every exit criterion passes locally against
fakes (`pnpm test:e2e`). Still to do: the live run with the test Slack app, the tailnet route,
the worker environment check, and the deployment. Built beyond milestone 1: in-app worker sign-in,
schedules with silent clean checks and the digest, memory, the pack (overlay, jobs, allow-list),
result checks and the verifier subagent, quiet mode, `/sym`, card buttons, feedback and learned
playbook rows, steering, PR wakes, the sign-in expiry notice, the worker MCP channel, per-job
worker models, the project allow-list, the worker label, owner-managed MCP connections,
shared-thread manners, stranger replies, results written in the persona's voice, and opt-in Slack
code channels for started jobs.

## Commands

Node 24 and pnpm, pinned in `mise.toml`. Run tools through mise, for example
`mise exec -- pnpm test`.

- `pnpm install`
- `pnpm lint` (Biome), `pnpm typecheck` (tsc), `pnpm test` (Vitest), `pnpm knip`
- `pnpm build:compile` compiles the agent without sandbox preparation. CI runs it.
- `pnpm build` is the full `eve build` for deploy images. It pulls Eve's sandbox image.
- `pnpm dev` starts `eve dev` with the terminal UI. Agents use `pnpm exec eve dev --no-ui` in a
  background process, then stop it after the check.
- `pnpm eval` runs `eve eval` (decision 039). It uses the real brain model and spends tokens, so
  the owner runs it. It loads `.env.local` and needs a gateway credential (`AI_GATEWAY_API_KEY`
  or `eve link`), `SYM_MODEL`, and Postgres. Setup moves the run to its own database,
  `SYM_EVAL_DATABASE_URL` (default `sym_eval` on the local Postgres), and creates and migrates
  it (decision 064). `pnpm eval <id>` runs one case. On a free-tier key, add
  `--max-concurrency 1`. `SYM_MODEL=fixture pnpm eval` proves the wiring with no provider; the
  routing cases then fail.
  The script sets `SYM_PROJECTS=example-app`, the project the eval cases use (decision 042). It
  skips the persona cases. `pnpm eval:plain` and `pnpm eval:spicy` run those, each with its
  `SYM_PERSONA`, because the persona is one setting for the whole run (decision 044).
- `pnpm db:up` starts only the Postgres 18 service of `compose.yaml`, on `127.0.0.1:55432`. `pnpm db:down` stops
  it. Ledger tests need it and `DATABASE_URL=postgres://sym:sym@localhost:55432/sym`.
- `pnpm db:migrate` applies pending ledger migrations (`lib/ledger/migrations.ts`).
- `pnpm t3:login <mcp-url>` signs Sym in to a T3 worker and saves the token to `.env.local`. The
  owner approves in the browser. `pnpm t3:check` lists the worker's projects and providers.
- `pnpm t3:job-smoke <project>` runs the job steps live without Eve. It launches a real worker
  thread, so use a throwaway project.
- `pnpm test:e2e` runs a real `eve dev` with the fixture brain (`SYM_MODEL=fixture`), a fake T3
  server, a fake Slack API, signed Slack events, and the local Postgres (decision 023).
- `docker build -t sym .` builds the deploy image (decision 019).

Local secrets go in `.env.local` (gitignored). `.env.example` lists the variables. Agents never
read `.env.local`.

Tests use fakes and never call a real worker, the real Slack API, or a paid model. Ledger tests
use a real Postgres (decision 014). Modules that a `"use workflow"` body reaches (such as
`lib/jobs/**` from `t3_job`) must not import Node.js builtins; `pnpm build:compile` catches it.

## Code layout

| Folder | Owns |
|---|---|
| `agent/` | The Eve agent: `agent.ts`, instructions, channels, tools, schedules, subagents, memory |
| `lib/` | Sym modules the agent imports: the display rule, the database client, the ledger, worker adapters (`workers/`), job steps (`jobs/`), Slack delivery (`slack/`, `delivery/`), schedules and the digest, memory, learning rows, quiet mode and feedback, the pack, and the fixture brains (`brain/`) |
| `scripts/` | Operator scripts run with `node`, such as the T3 sign-in and check |
| `test/` | Vitest tests. `test/fakes/` holds the fake worker, a fake T3 MCP server, and a fake Slack API. `test/helpers/` gives each ledger test file its own schema and signs Slack events. `test/e2e/` runs the whole agent |
| `slack/` | Slack app manifest |
| `docs/` | Design documents, decisions, and mockups |

## Git

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`).
