# OSS Documentation & Community-Health Best Practice

Research date: 2026-06-02. Covers 2024-2026 practice.

---

## Key Takeaways

1. **README is the project's first impression.** Follow the Standard Readme spec for section order: title, one-liner, ToC, install, usage, contributing, license. Put the "what / why / how" inside 100 words above the fold — before anyone scrolls.

2. **ARCHITECTURE.md is the highest-leverage doc for contributor retention.** matklad's essay (rust-analyzer) proved that a brief, stable "codemap" — not a full design doc — collapses the time for an occasional contributor to become effective. Target: 300-600 words, updated a few times a year, not in sync with every commit.

3. **Diátaxis gives you four buckets; stop mixing them.** Tutorial (learning), How-to guide (task), Reference (look-up), Explanation (understanding) each serve a different reader mental state. The failure mode is writing reference prose inside a tutorial (or vice versa), which exhausts beginners and frustrates advanced users.

4. **GitHub's "community health" checklist is the floor.** GitHub surfaces a community standards score on public repos. The floor: LICENSE, README, CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, at least one issue template. Missing any of these visibly signals immaturity to prospective contributors.

5. **Conventional Commits + Keep a Changelog form a closed loop.** Conventional Commits structures the git log; Keep a Changelog structures the file humans read. CHANGELOG.md is written for users, not for machines — automated generation (git-cliff, changesets) produces a first draft, humans polish it.

6. **AGENTS.md (or CLAUDE.md) is now a first-class community file.** Over 20,000 repos on GitHub carry one. It tells AI coding agents (Copilot, Claude Code, Cursor, etc.) exactly how to work in this repo: commands, test conventions, project structure, style examples, explicit boundaries. A good AGENTS.md significantly reduces friction for AI-assisted contributions.

7. **"Good first issue" as explicit infrastructure.** Labels alone are not enough. The best projects pair them with a short "scope, expected outcome, files to look at" block in the issue body, making the first contribution achievable in under an hour.

8. **PR templates must be scoped to contributors, not internal process.** Sym's current `.github/pull_request_template.md` is heavy with internal-only fields (Stream, Schema, Contracts, cross-unit impact). For an OSS launch, either trim it to contributor-friendly fields or maintain two templates: one for maintainers, one for external contributors.

---

## Reference Repositories

| Repository                                  | Specific lesson to copy                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **rust-lang/rust-analyzer**                 | Gold standard `ARCHITECTURE.md`: bird's-eye view → codemap (per-crate table with `Architecture Invariant:` callouts) → cross-cutting concerns. Keep it stable; link by symbol search, not URL.                                                                     |
| **biomejs/biome**                           | `CONTRIBUTING.md` as a layered doc: short intro → setup → test → per-domain sub-guides (separate contributing files per crate). AI disclosure requirement. Conventional Commits enforced by PR linter. Changesets for CHANGELOG automation with per-type examples. |
| **withastro/astro**                         | Monorepo `CONTRIBUTING.md` with explicit architectural separation (Node-only code vs runtime-agnostic code). Node/pnpm version pinning stated up front. Codespaces option lowers first-contribution friction.                                                      |
| **trpc/trpc**                               | `CONTRIBUTING.md` opens with a warm accessibility statement ("don't hesitate to reach out on Discord") before any setup steps. Packages listed with a one-sentence purpose each — mirrors what an ARCHITECTURE codemap should do.                                  |
| **supabase/supabase**                       | Modular community files: `CONTRIBUTING.md` is short; `DEVELOPERS.md` covers deep setup. Feature PRs require a Discussion before the PR ("if a feature hasn't gone through a proper design process, your PR will be closed").                                       |
| **keepachangelog/keepachangelog**           | Canonical `CHANGELOG.md` format: Unreleased section at top, ISO 8601 dates, six fixed change types (Added / Changed / Deprecated / Removed / Fixed / Security), humans write it not machines.                                                                      |
| **conventionalcommits/conventionalcommits** | Commit message convention: `<type>[scope]: <desc>` maps directly to SemVer (feat→MINOR, fix→PATCH, BREAKING CHANGE→MAJOR). Enables automated tooling while remaining readable.                                                                                     |
| **RichardLitt/standard-readme**             | Standard Readme spec: required section order (title, description, ToC, install, usage, contributing, license); optional sections (badges, background, API, maintainers). Description must be under 120 chars.                                                      |
| **matiassingers/awesome-readme**            | Curated exemplars. `doomemacs/doomemacs` (humorous tone that defines the project), `gofiber/fiber` (logo + badges + examples + philosophy), `ai/size-limit` (screenshot above the fold).                                                                           |
| **ossf/project-template**                   | Minimal `SECURITY.md` template: reporting channel, preference for GitHub Private Vulnerability Reporting, one escalation contact. 11 lines — clarity beats length for security policies.                                                                           |
| **10up/open-source-best-practices**         | Community health checklist with README anatomy (logo ≤100px, badges, feature list with CHANGELOG link, contributing reference). Good template for what "done" looks like.                                                                                          |
| **agentsmd/agents.md**                      | `AGENTS.md` open standard now supported by Copilot, Cursor, Claude Code. Six core sections: commands, testing, project structure, code style examples, git workflow, explicit boundaries. Code examples beat prose descriptions.                                   |

---

## Recommendations for Sym

These are concrete, file-level actions ordered by priority. "Currently missing" = the file does not exist in the repo as of 2026-06-02.

### P0 — Required before any public OSS announcement

**1. Rewrite README.md to match Standard Readme section order.**

Current README is functional but not structured for an OSS audience. Missing: badges (CI status, license, Node version), a screenshot or demo GIF of Sym answering a Slack message, a visible "Why Sym?" pitch. Required order:

```
# Sym
<one-liner ≤ 120 chars>
[badges]
[screenshot or demo GIF]
## Why
## Install / Quick-start
## Environment variables (already exists, keep)
## Setup  (already exists, keep)
## Repository layout (expand — see below)
## Contributing
## License
```

The repo layout section currently lists only `apps/agent` and `docs/FUTURE.md`. It omits `packages/adapter/slack`, `packages/contracts`, `packages/kernel`, `slack/`, `dokploy/`, `scripts/`, and `assets/`. Every top-level directory needs a one-line description.

**2. Add LICENSE attribution check.** `LICENSE` exists and says "MIT License / Copyright (c) 2026 Sym authors". Before open-sourcing, add the actual author name(s) — "Sym authors" is a placeholder.

**3. Create CONTRIBUTING.md.**

Minimum viable for OSS launch (keep it short — link to deeper docs):

```markdown
# Contributing to Sym

Questions → GitHub Discussions or the issue tracker.
Bug reports → use the Bug Report issue template.
Feature ideas → open a Discussion first; PRs without a linked Discussion may be closed.

## Setup

- Node >=24, pnpm >=10
- `pnpm install && pnpm build`
- `pnpm test` to verify

## Commit messages

Conventional Commits are enforced by commitlint.
`feat(slack): ...` / `fix(agent): ...` / `chore(deps): ...`

## Pull requests

- One logical change per PR.
- All CI checks must pass.
- External contributors: use the external PR template (strips internal fields).
```

**4. Create SECURITY.md.**

Minimal template — 10-15 lines:

```markdown
# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Use GitHub's [Private Vulnerability Reporting](https://github.com/YOUR_ORG/sym/security/advisories/new)
to report confidentially. You will receive an acknowledgement within 48 hours.

If PVR does not work for you, email [security contact email] directly.

## Scope

Sym is a single-tenant personal bot. The primary threat surface is:

- `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` leakage
- Server-side request forgery via MCP tool calls
- Prompt injection via Slack messages
```

**5. Create CODE_OF_CONDUCT.md.**

Use the Contributor Covenant v2.1 verbatim. It is the industry standard, one command to add:

```sh
npx covgen YOUR_EMAIL
```

or copy from https://www.contributor-covenant.org/version/2/1/code_of_conduct/

**6. Create .github/ISSUE_TEMPLATE/ with two templates.**

`bug_report.yml`:

```yaml
name: Bug report
description: Something is broken
labels: [bug]
body:
  - type: textarea
    id: description
    attributes:
      label: What happened?
  - type: textarea
    id: reproduce
    attributes:
      label: Steps to reproduce
  - type: input
    id: node-version
    attributes:
      label: Node version
      placeholder: 'node --version'
  - type: input
    id: pnpm-version
    attributes:
      label: pnpm version
```

`feature_request.yml`:

```yaml
name: Feature request
description: Propose an idea
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve?
  - type: textarea
    id: solution
    attributes:
      label: Proposed solution
```

**7. Slim the PR template for external contributors.** The existing `.github/pull_request_template.md` contains internal fields ("Stream", "Cross-unit impact", schema migration notes, contracts notes) that are meaningless to external contributors and look intimidating. For OSS, either:

- Move the current template to `.github/PULL_REQUEST_TEMPLATE/maintainer.md` (internal use, selected via `?template=maintainer.md`)
- Create a lean `.github/pull_request_template.md` for external contributors:

```markdown
## What changed and why

## Verification

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
```

### P1 — High value, do before first public traffic

**8. Create ARCHITECTURE.md at repo root.**

Following the matklad/rust-analyzer format. For Sym the codemap is small — that is an asset. Draft:

```markdown
# Architecture

Sym is a single stateless Hono server. A Slack event arrives, passes
through a verification + owner gate, the full thread is fetched as context,
a Pi agent loop calls Fireworks, and the reply streams back into Slack.

No database. No dashboard. The Slack thread IS the memory.

## Codemap

packages/contracts/ Shared TypeScript types (SlackEvent, AgentConfig, etc.)
packages/kernel/ Pure business logic with no I/O dependencies
packages/adapter/slack/ Slack API client (Web API + retry logic)
apps/agent/
server.ts Hono entrypoint; registers /slack/events route
slack-guard.ts Verifies Slack signing secret; drops non-owner events
handle-turn.ts Orchestrates: fetch thread → Pi loop → stream reply
pi/ Pi agent loop: tool dispatch, streaming, cancellation
mcp/ MCP client: stdio transport, tool registry, dispatcher
builtin-tools.ts Built-in read-only tools (web fetch, file read, etc.)

## Architecture invariants

- apps/agent has NO runtime dependency on any database or secret store.
  Configuration arrives exclusively via environment variables.
- packages/kernel has NO dependency on Slack — it knows nothing about HTTP or
  Slack data shapes. All Slack types come from packages/adapter/slack.
- handle-turn is the only place that calls the Pi loop. Nothing else initiates
  an agent turn.
- The MCP dispatcher (mcp/) is the sole integration point for external tools.
  builtin-tools.ts registers tools directly; external MCP servers register
  via environment-configured stdio transports.
```

**9. Create CHANGELOG.md following Keep a Changelog format.**

Start with an `[Unreleased]` section at the top. Every release gets a dated entry. The six section types: Added, Changed, Deprecated, Removed, Fixed, Security.

Sym already uses commitlint with Conventional Commits — wire up `git-cliff` or `@changesets/cli` to auto-draft the CHANGELOG from commit history. The automated output needs a human pass before each release (commit message language is for devs; changelog language is for users).

**10. Create AGENTS.md at repo root.**

Based on the GitHub/agentsmd.github.io standard. Given that Sym is already built with Claude Code and contributors will use AI agents, this is unusually high-value here:

```markdown
# AGENTS.md

## Role

You are contributing to Sym, a stateless single-tenant Slack AI bot.
Stack: TypeScript, pnpm workspaces, Turbo, Hono, Pi agent SDK, Fireworks LLM.

## Commands

pnpm install # install all workspace deps
pnpm build # build all packages (turbo)
pnpm test # run all tests (turbo)
pnpm lint # eslint + prettier check
pnpm typecheck # tsc --noEmit across all packages

## Project structure

See ARCHITECTURE.md for the codemap.

## Code style

- ESM only (type: "module" in all package.json)
- NodeNext module resolution
- No default exports except for Hono app in server.ts
- Server logs: console.info/warn/error ONLY — never console.log
  (the real-wire test harness spies on console.log for JSON output)

## Git workflow

Commit messages: Conventional Commits enforced by commitlint
feat(slack): ... fix(agent): ... chore(deps): ...
Never skip: pnpm build + pnpm test must pass before commit.

## Boundaries

Always do: run typecheck before editing cross-package interfaces
Ask first: adding new environment variables, new pnpm dependencies
Never do: start the dev server (pnpm dev), modify .env files,
commit secrets, use console.log in server code
```

### P2 — Polish and long-term health

**11. Badges in README.md.** Add at minimum:

- CI status badge (`.github/workflows/ci.yml` → GitHub Actions badge)
- License badge (`[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)`)
- Node version badge (`[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-green)]`)

**12. "Good first issue" infrastructure.** When issues are opened, use the `good first issue` label with a scope description in the body:

```
Good first issue: [one sentence scope]
Files to look at: [2-3 specific files]
Expected outcome: [what done looks like]
Time estimate: [1-3 hours]
```

**13. Diátaxis-structure the docs/ directory.** Currently `docs/` contains `FUTURE.md`, `mcp-setup.md`, and `refactor/`. Before OSS launch, structure it:

```
docs/
  tutorials/       getting-started.md (learning-oriented, hand-held)
  how-to/          deploy-to-dokploy.md, add-mcp-server.md (task-oriented)
  reference/       env-vars.md (the full env table, currently in README)
  explanation/     architecture-decisions.md, why-stateless.md
```

Moving the env vars reference out of README into `docs/reference/env-vars.md` (with a short summary + link in README) keeps the README from becoming a reference dump.

**14. Address the README repo-layout drift.** The current README lists only `apps/agent` + `docs/`. The actual repo has: `packages/adapter/slack`, `packages/contracts`, `packages/kernel`, `slack/` (Slack app manifest), `dokploy/` (deploy config), `scripts/`, `assets/`. Each directory needs a one-line description in the layout section. This gap is the most obviously "AI-generated slop" signal to a newcomer — it signals the docs are not maintained.

**15. Expand .github/workflows/ci.yml with a required-status-checks gate.** The CI badge is a trust signal. Ensure the workflow runs `pnpm typecheck && pnpm lint && pnpm test && pnpm build` on every PR. Document this in CONTRIBUTING.md so contributors know what "green" means.

---

## File checklist (priority order)

| File                                         | Status                  | Priority | Action                                                                      |
| -------------------------------------------- | ----------------------- | -------- | --------------------------------------------------------------------------- |
| `README.md`                                  | exists, needs expansion | P0       | Restructure per Standard Readme; fix repo layout section                    |
| `LICENSE`                                    | exists                  | P0       | Add real author name(s)                                                     |
| `CONTRIBUTING.md`                            | missing                 | P0       | Create (short, contributor-friendly)                                        |
| `SECURITY.md`                                | missing                 | P0       | Create (minimal, PVR + contact)                                             |
| `CODE_OF_CONDUCT.md`                         | missing                 | P0       | Add Contributor Covenant v2.1                                               |
| `.github/ISSUE_TEMPLATE/bug_report.yml`      | missing                 | P0       | Create                                                                      |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | missing                 | P0       | Create                                                                      |
| `.github/pull_request_template.md`           | exists, too heavy       | P0       | Create lean external version; keep maintainer variant                       |
| `ARCHITECTURE.md`                            | missing                 | P1       | Create (codemap + invariants)                                               |
| `CHANGELOG.md`                               | missing                 | P1       | Create with Unreleased section; add git-cliff or changesets                 |
| `AGENTS.md`                                  | missing                 | P1       | Create (six sections: commands, testing, structure, style, git, boundaries) |
| `docs/` structure                            | flat/mixed              | P2       | Apply Diátaxis (tutorials/, how-to/, reference/, explanation/)              |
| CI badge in README                           | missing                 | P2       | Add GitHub Actions badge                                                    |
| `good first issue` label + template body     | missing                 | P2       | Add label + scoped issue body convention                                    |

---

## Sources

- matklad, "ARCHITECTURE.md": https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html
- rust-analyzer architecture docs: https://rust-analyzer.github.io/book/contributing/architecture.html
- Diátaxis framework: https://diataxis.fr/
- Standard Readme spec: https://github.com/RichardLitt/standard-readme/blob/main/spec.md
- Keep a Changelog: https://keepachangelog.com/en/1.1.0/
- Conventional Commits: https://www.conventionalcommits.org/en/v1.0.0/
- GitHub community profiles: https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories
- Biome CONTRIBUTING.md: https://github.com/biomejs/biome/blob/main/CONTRIBUTING.md
- Astro CONTRIBUTING.md: https://github.com/withastro/astro/blob/main/CONTRIBUTING.md
- tRPC CONTRIBUTING.md: https://github.com/trpc/trpc/blob/main/CONTRIBUTING.md
- Supabase CONTRIBUTING.md: https://github.com/supabase/supabase/blob/master/CONTRIBUTING.md
- OpenSSF project-template SECURITY.md: https://github.com/ossf/project-template/blob/main/SECURITY.md
- 10up Open Source Best Practices: https://10up.github.io/Open-Source-Best-Practices/community/
- awesome-readme: https://github.com/matiassingers/awesome-readme
- AGENTS.md open standard: https://github.com/agentsmd/agents.md
- GitHub blog on agents.md: https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
