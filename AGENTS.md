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

Milestone 1 is in progress (`docs/milestone-1.md`). Done: the Eve scaffold, tooling, CI, and
`chooseDisplay` with unit tests. Next: the T3 connection, the ledger, and the `t3_job` tool.

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

Local secrets go in `.env.local` (gitignored). `.env.example` lists the variables. Agents never
read `.env.local`.

Tests use fakes and never call a real worker, the real Slack API, or a paid model.

## Code layout

| Folder | Owns |
|---|---|
| `agent/` | The Eve agent: `agent.ts`, instructions, channels, tools, schedules, hooks, skills |
| `lib/` | Sym modules the agent imports: the display rule, and later the ledger and worker adapters |
| `test/` | Vitest unit tests |
| `slack/` | Slack app manifest |
| `docs/` | Design documents, decisions, and mockups |

## Git

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`).
