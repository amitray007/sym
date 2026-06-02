# Zone Z02: Tooling — lint, format, hooks, CI

## Summary

The tooling foundation is solid: flat ESLint 9 config, Prettier, Husky v9, commitlint, and a tight turbo pipeline all hang together correctly. The bones are right. However, several gaps block an OSS launch: (1) `no-explicit-any` is `warn` with no `--max-warnings 0` guard, so `any` violations silently pass CI; (2) there is no import-boundary enforcement between packages; (3) dead-architecture artifacts litter scripts/, `.prettierignore`, `.gitignore`, `commitlint.config.js`, and the PR template (Postgres setup scripts, Drizzle migration entries, `db`/`secrets`/`dashboard`/`audit` scopes, schema/OTel review sections); (4) `dev/` and `tmp/` are missing from `.dockerignore`; (5) `.vscode/extensions.json` recommends the Drizzle extension for a project that no longer uses Drizzle; (6) CI hardcodes `node-version: '24'` instead of reading from `.nvmrc` (drift risk); (7) no dead-export checker (knip) or import-graph boundary tool (dependency-cruiser) exists; (8) the PR template contains internal build-plan jargon (`Sp1`, `S7a`) and mandatory sections for removed features (`Schema / migration notes`, `Audit + OTel added`) that will confuse external contributors.

---

## Findings

| ID     | Severity | Category  | Title                                                                                                                                    | Files                                                                      | Effort  |
| ------ | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| Z02-01 | high     | config    | `no-explicit-any` is `warn` — violations pass CI silently                                                                                | `eslint.config.js:44`, `lint-staged.config.js:7`                           | trivial |
| Z02-02 | high     | dead-code | Dead setup scripts reference removed Postgres/Redis/encryption-key infra                                                                 | `scripts/dev-setup.sh`, `scripts/setup-macos.sh`, `scripts/setup-linux.sh` | trivial |
| Z02-03 | high     | dead-code | `.prettierignore` references files and dirs that do not exist                                                                            | `.prettierignore:14-27`                                                    | trivial |
| Z02-04 | high     | dead-code | `commitlint.config.js` scope-enum lists removed scopes and omits live scopes                                                             | `commitlint.config.js:22-51`                                               | small   |
| Z02-05 | high     | dead-code | PR template has internal jargon and mandatory sections for removed features                                                              | `.github/pull_request_template.md:11-48`                                   | small   |
| Z02-06 | medium   | security  | `.dockerignore` missing `dev/`, `tmp/`, `.claude/` — sensitive/noisy paths leak into build context                                       | `.dockerignore`                                                            | trivial |
| Z02-07 | medium   | config    | CI hardcodes `node-version: '24'` instead of reading `.nvmrc` — drift risk                                                               | `.github/workflows/ci.yml:41-42`                                           | trivial |
| Z02-08 | medium   | config    | No import-boundary enforcement between `@sym/*` packages (no dependency-cruiser or knip)                                                 | `eslint.config.js`                                                         | medium  |
| Z02-09 | medium   | config    | `no-explicit-any: 'warn'` in test override is redundant — already `off` for tests                                                        | `eslint.config.js:90`                                                      | trivial |
| Z02-10 | medium   | dx        | `.vscode/extensions.json` recommends Tailwind CSS and Drizzle extensions — neither is in the project                                     | `.vscode/extensions.json:4-5`                                              | trivial |
| Z02-11 | medium   | config    | `lint-staged` does not pass `--max-warnings 0` to ESLint — warnings silently pass pre-commit                                             | `lint-staged.config.js:7`                                                  | trivial |
| Z02-12 | medium   | config    | Turbo `lint` and `typecheck` inputs use `test/**` but project convention is `tests/**` — stale-cache risk                                | `turbo.json:35,46`                                                         | trivial |
| Z02-13 | low      | config    | `import/order` has no `pathGroups` entry for `@sym/*` — workspace packages sort as external, not internal                                | `eslint.config.js:58-65`                                                   | small   |
| Z02-14 | low      | dead-code | `.gitignore` lists Drizzle artefacts (`drizzle/.snapshots`, `drizzle-meta`) for a removed feature                                        | `.gitignore:53-54`                                                         | trivial |
| Z02-15 | low      | dead-code | `.gitignore` and `tsconfig.base.json` reference `build/` and `.next/` — no Next.js in the repo                                           | `.gitignore:7`, `tsconfig.base.json:5`                                     | trivial |
| Z02-16 | low      | config    | `tsconfig.base.json` sets `noUnusedLocals: false` and `noUnusedParameters: false` — unused-imports plugin covers JS but not type aliases | `tsconfig.base.json:10-11`                                                 | small   |
| Z02-17 | low      | config    | CI `evals` job uses `if: false` — a permanently-disabled job adds noise; prefer deleting until needed                                    | `.github/workflows/ci.yml:67-79`                                           | trivial |
| Z02-18 | low      | docs      | No `CONTRIBUTING.md` or `SECURITY.md` — missing OSS baseline                                                                             | (none exist)                                                               | small   |
| Z02-19 | low      | config    | `turbo.json` `globalDependencies` lists `.env` and `.env.*` — every local `.env` change busts all task caches                            | `turbo.json:6-7`                                                           | small   |
| Z02-20 | low      | config    | GitHub Actions use floating major-version tags (`@v4`) — pin to SHA for supply-chain safety in OSS                                       | `.github/workflows/ci.yml:33,39,74`                                        | small   |

---

## Detail

### Z02-01 — `no-explicit-any` is `warn`: violations pass CI silently

**Evidence:**

```js
// eslint.config.js:44
'@typescript-eslint/no-explicit-any': 'warn',
```

```js
// lint-staged.config.js:7
'*.{ts,tsx,...}': ['eslint --fix', 'prettier --write'],
// no --max-warnings flag
```

Neither the pre-commit hook nor CI per-package `lint` scripts pass `--max-warnings 0`. `eslint` exits 0 on warnings, so `as any` casts (found in `apps/agent/src/pi/tools.ts:53` and `apps/agent/src/pi/meta-tools.ts:161,239`) are never flagged as failures.

**Recommendation:** Upgrade `'@typescript-eslint/no-explicit-any': 'warn'` to `'error'` (there are only ~3 non-test sites; each is addressable with `as unknown as T` or a type assertion comment). Alternatively, keep `'warn'` but add `--max-warnings 0` everywhere ESLint is invoked.

---

### Z02-02 — Dead setup scripts for removed infra

**Evidence:**

```sh
# scripts/dev-setup.sh:1-17
# One-time dev environment bootstrap:
#   1. Creates the sym_dev Postgres database (idempotent).
#   2. Generates a SYM_ENCRYPTION_KEY and writes it into .env.
#   3. Runs pnpm db:migrate to prime the schema.
```

`scripts/setup-macos.sh` installs `postgresql@16` and `redis` via Homebrew. `scripts/setup-linux.sh` does the same via apt. The North Star is stateless — no Postgres, no Redis, no encryption key, no DB. These scripts are entirely dead and will actively mislead OSS newcomers.

**Recommendation:** Delete all three scripts (`dev-setup.sh`, `setup-macos.sh`, `setup-linux.sh`). Add a single `scripts/setup.sh` that covers the real onboarding: `pnpm install`, copy `.env.example` → `.env`, fill in Slack + Fireworks keys.

---

### Z02-03 — `.prettierignore` references non-existent files/dirs

**Evidence:**

```
# .prettierignore:14-27
drizzle/.snapshots          # drizzle/ dir does not exist
drizzle-meta                # does not exist
**/drizzle/**/*.json        # does not exist
**/migrations/**            # does not exist
docs/specs/**               # docs/specs/ does not exist
docs/db-schema-draft.md     # does not exist
docs/implementation-ideology-plan.md  # does not exist
docs/build-flow.md          # does not exist
docs/files-to-care-about.md # does not exist
docs/ideation.html          # does not exist
```

None of these paths exist in the repo (verified with `ls`). These are remnants of the old database-backed architecture.

**Recommendation:** Strip all Drizzle and removed-docs entries. Keep only the lines that reference real artefacts (`node_modules`, `dist`, `build`, `pnpm-lock.yaml`, `.turbo`, etc.).

---

### Z02-04 — `commitlint.config.js` scope-enum is stale

**Evidence:**

```js
// commitlint.config.js:22-51 — scope-enum (severity=1=warn)
// IN enum but NEVER appear in git log:  fireworks, onboarding, skills, deps
// IN enum but refer to removed features: db, secrets, dashboard, sandbox, memory, audit, tasks, soul
// USED in git log but NOT in enum:       connectors, deploy, manifest, render, scripts, readme
```

Concretely, `git log --format="%s" --all` across 220 commits shows `connectors`, `deploy`, `manifest`, `render`, `scripts`, and `readme` all used in practice. Severity=1 means violations are warnings not errors, so this has no hard enforcement effect — but it adds noise and confuses contributors.

**Recommendation:** Prune removed-feature scopes (`db`, `secrets`, `dashboard`, `onboarding`, `sandbox`, `memory`, `audit`, `tasks`, `soul`, `skills`, `fireworks`). Add real live scopes (`connectors`, `deploy`, `manifest`). Consider upgrading `scope-enum` to severity `2` (error) once the list is clean.

---

### Z02-05 — PR template contains internal jargon and removed-feature sections

**Evidence:**

```md
## Stream

<!-- Which build-plan stream owns this change? e.g. Sp1, Sp2, S1, S7a, S8 -->

Stream:
End goal touched:
```

```md
## Schema / migration notes

<!-- Only required if this PR touches packages/db/. Otherwise delete this section. -->

- Additive only? ...
- Drizzle types regenerated and committed?
```

```md
- **Audit + OTel added:** <!-- list event names + semantic keys, or N/A (why) -->
```

`packages/db/` does not exist. There is no audit log or OTel instrumentation. `Sp1`, `S7a`, `S8` are internal build-plan labels meaningless to a newcomer. The template was clearly generated for a more complex architecture and never pruned.

**Recommendation:** Remove the `Stream` section and the internal examples (`Sp1`, `S7a`). Remove `Schema / migration notes` and `Contracts notes` (no `packages/db/` or contracts versioning). Simplify `Audit + OTel added` to a generic "Observability / logging" note or remove it. Keep `Cross-unit impact`, `Verification`, `What changed`, and `Summary`.

---

### Z02-06 — `.dockerignore` missing `dev/`, `tmp/`, `.claude/`

**Evidence:**

```
# .dockerignore — full content (no mention of dev/, tmp/, or .claude/)
```

`dev/script.sh` is a gitignored local file containing server provisioning commands. If a developer has a local `dev/` directory it will be included in the Docker build context (`COPY . .` in `Dockerfile:24`). Similarly `tmp/` (gitignored, exists locally per `ls /sym/tmp/`) and `.claude/worktrees/` (large, contains old sub-agent worktrees) are absent.

**Recommendation:** Add `dev/`, `tmp/`, and `.claude/` to `.dockerignore`.

---

### Z02-07 — CI hardcodes `node-version: '24'` instead of reading `.nvmrc`

**Evidence:**

```yaml
# .github/workflows/ci.yml:39-42
- name: Setup Node 24
  uses: actions/setup-node@v4
  with:
    node-version: '24'
```

`.nvmrc` contains `24`. These are currently in sync, but the version is repeated in two places — upgrading Node requires a change in both files.

**Recommendation:** Replace `node-version: '24'` with `node-version-file: '.nvmrc'`. This is the canonical pattern for `actions/setup-node@v4`.

---

### Z02-08 — No import-boundary enforcement between `@sym/*` packages

**Evidence:**

```js
// eslint.config.js — no import/no-extraneous-dependencies, no-restricted-imports, no dependency-cruiser
```

Nothing prevents `packages/contracts` from importing `@sym/kernel`, or `packages/adapter/slack` from directly importing `apps/agent` internals. The monorepo structure implies a dependency DAG (`contracts ← kernel ← adapter-slack ← agent`) but it is purely by convention.

**Recommendation:** Add `eslint-plugin-import`'s `import/no-extraneous-dependencies` rule (packages should only import what's in their own `dependencies`). Consider adding [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) with a `.dependency-cruiserrc.js` that formalizes the DAG and fails CI on violations. Optionally add [knip](https://knip.dev) for dead-export detection.

---

### Z02-09 — Redundant `no-explicit-any: 'off'` override in test overrides

**Evidence:**

```js
// eslint.config.js:88-93
{
  files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**', '**/tests/**'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',  // redundant if main rule is 'warn'
    'no-console': 'off',
  },
},
```

If the main rule is promoted to `'error'` (per Z02-01), this override becomes necessary. Currently, setting `'off'` over `'warn'` is correct but inconsistent in intent — it should be kept as-is once the main rule becomes `'error'`.

**Recommendation:** No immediate action needed beyond the Z02-01 fix; just ensure this override remains in place after upgrading the main rule to `'error'`.

---

### Z02-10 — VS Code recommends Tailwind CSS and Drizzle extensions

**Evidence:**

```json
// .vscode/extensions.json:4-5
"bradlc.vscode-tailwindcss",
"drizzle-team.drizzle-vscode"
```

Neither Tailwind CSS nor Drizzle ORM is present in the codebase. `grep tailwindcss package.json` and `ls packages/db` both return nothing. These recommendations will confuse contributors who install all recommended extensions.

**Recommendation:** Remove both lines. Keep `dbaeumer.vscode-eslint`, `esbenp.prettier-vscode`, `editorconfig.editorconfig`.

---

### Z02-11 — `lint-staged` does not enforce `--max-warnings 0`

**Evidence:**

```js
// lint-staged.config.js:7
'*.{ts,tsx,...}': ['eslint --fix', 'prettier --write'],
```

ESLint exits 0 when there are only warnings. The pre-commit hook will pass even if `no-explicit-any` warnings accumulate. (Related to Z02-01.)

**Recommendation:** Change to `'eslint --fix --max-warnings 0'` once all existing warnings are cleared.

---

### Z02-12 — Turbo `lint` and `typecheck` inputs use `test/**` but convention is `tests/**`

**Evidence:**

```json
// turbo.json:35 (lint inputs)
"test/**",
// turbo.json:46 (typecheck inputs)
"test/**",
```

The project convention (per memory and per actual file layout) puts tests in `tests/` (plural). The `test` task correctly lists both `test/**` and `tests/**`. `lint` and `typecheck` only list `test/**`. If a developer changes a file in `tests/`, turbo may serve a stale lint/typecheck cache.

**Recommendation:** Add `"tests/**"` to the `lint` and `typecheck` `inputs` arrays in `turbo.json`.

---

### Z02-13 — `import/order` has no `pathGroups` for `@sym/*`

**Evidence:**

```js
// eslint.config.js:58-65
'import/order': ['warn', {
  groups: ['builtin', 'external', 'internal', ...],
  // no pathGroups entry for @sym/*
}],
```

Without a `pathGroups` entry, `@sym/kernel`, `@sym/contracts`, and `@sym/adapter-slack` imports sort into the `external` group (third-party npm), not `internal` (workspace packages). This means ESLint does not enforce the desired separation between third-party and workspace imports.

**Recommendation:**

```js
pathGroups: [{ pattern: '@sym/**', group: 'internal', position: 'before' }],
pathGroupsExcludedImportTypes: ['builtin'],
```

---

### Z02-14 — `.gitignore` lists Drizzle artefacts for a removed feature

**Evidence:**

```
# .gitignore:53-54
drizzle/.snapshots
drizzle-meta
```

`drizzle/` does not exist. These entries are harmless but signal the project's past complexity to newcomers.

**Recommendation:** Remove the Drizzle lines from `.gitignore`. Keep `*.sqlite`/`*.db` (still relevant for the MCP OAuth credentials database).

---

### Z02-15 — `.gitignore` and `tsconfig.base.json` reference `build/` and `.next/`

**Evidence:**

```
# .gitignore:7
build/
.next/
```

```json
// tsconfig.base.json:5 (exclude array)
".next"
```

There is no Next.js app and no `build/` output directory. All build outputs go to `dist/`. These entries are noise.

**Recommendation:** Remove `build/` and `.next/` from `.gitignore` `exclude` list. Leave `out/` only if there's a future use case, otherwise remove.

---

### Z02-16 — `tsconfig.base.json` disables `noUnusedLocals` and `noUnusedParameters`

**Evidence:**

```json
// tsconfig.base.json:10-11
"noUnusedLocals": false,
"noUnusedParameters": false,
```

The `unused-imports/no-unused-vars` ESLint rule partially covers this, but TypeScript's own check catches unused type aliases and type-only imports that ESLint cannot see reliably. Leaving both `false` means dead types accumulate silently.

**Recommendation:** Enable `noUnusedLocals: true` and `noUnusedParameters: true`. The convention of prefixing intentionally-unused parameters with `_` (already in the ESLint pattern `argsIgnorePattern: '^_'`) also satisfies TypeScript's `noUnusedParameters`.

---

### Z02-17 — Permanently-disabled CI job (`if: false`) adds noise

**Evidence:**

```yaml
# .github/workflows/ci.yml:67-79
evals:
  name: promptfoo evals (stub — no-op until eval sets exist)
  if: false
  steps:
    - name: Placeholder
      run: echo "No eval sets yet — see TODO above."
```

A job gated by `if: false` never runs and never appears in the PR checks panel. It adds YAML bulk with no benefit. The TODO is better tracked as an issue.

**Recommendation:** Delete the `evals` job. Open a tracking issue titled "Add promptfoo eval sets for kernel/soul" with the current comment as the body.

---

### Z02-18 — Missing OSS baseline files

**Evidence:** `SECURITY.md` and `CONTRIBUTING.md` do not exist (verified with `ls`). `LICENSE` exists (MIT). For an OSS project these are expected by GitHub's community health dashboard and by external contributors.

**Recommendation:** Add a minimal `CONTRIBUTING.md` covering: clone, `pnpm install`, copy `.env.example`, run `pnpm dev`, `pnpm test`. Add a `SECURITY.md` with a responsible disclosure email. These are small but blocking for OSS launch.

---

### Z02-19 — `turbo.json` globalDependencies includes `.env` — busts all caches on any local env change

**Evidence:**

```json
// turbo.json:6-7
"globalDependencies": [
  "tsconfig.base.json",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.*.example"
],
```

Any edit to a local `.env` (e.g., changing `FIREWORKS_MODEL` for testing) busts every cached build, lint, typecheck, and test across all packages. In CI this is irrelevant (no `.env` in checkout), but it destroys local turbo caching during development.

**Recommendation:** Remove `.env` and `.env.*` from `globalDependencies`. The variables the builds actually depend on (none — builds are pure TS compilation) are not in `.env`. Runtime env vars are consumed by the process, not by the build. Use `globalEnv` for the handful of variables that affect build output if needed.

---

### Z02-20 — GitHub Actions use floating major-version tags

**Evidence:**

```yaml
# .github/workflows/ci.yml:33
uses: actions/checkout@v4
# .github/workflows/ci.yml:39
uses: actions/setup-node@v4
```

Floating major-version tags (`@v4`) allow upstream action maintainers to push a breaking or malicious commit that is automatically used on the next CI run. For an OSS project with public CI, this is a supply-chain risk.

**Recommendation:** Pin each action to its full SHA:

```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af  # v4.1.0
```

Use Dependabot's `github-actions` ecosystem to auto-update.

---

## Proposed Chunks

### Chunk 1 — Purge dead-architecture artefacts (no deps)

**Goal:** After this chunk, no file in the tooling zone references removed features (Postgres, Drizzle, Redis, secrets store, dashboard, audit, OTel). A newcomer reading the config files sees only the current stateless architecture.

**Findings addressed:** Z02-02, Z02-03, Z02-04, Z02-05, Z02-10, Z02-14, Z02-15, Z02-17

Actions:

- Delete `scripts/dev-setup.sh`, `scripts/setup-macos.sh`, `scripts/setup-linux.sh`.
- Strip Drizzle and removed-docs entries from `.prettierignore`.
- Remove `build/`, `.next/` from `.gitignore`; remove Drizzle lines.
- Remove `db`, `secrets`, `dashboard`, `onboarding`, `sandbox`, `memory`, `audit`, `tasks`, `soul`, `skills`, `fireworks` from `commitlint.config.js` scope-enum. Add `connectors`, `deploy`, `manifest`. Upgrade severity to `2`.
- Rewrite PR template: remove `Stream`, `Schema / migration notes`, `Contracts notes`, `Audit + OTel` line.
- Remove `bradlc.vscode-tailwindcss` and `drizzle-team.drizzle-vscode` from `.vscode/extensions.json`.
- Delete `evals` job from `ci.yml`.

---

### Chunk 2 — Tighten lint/type enforcement (depends on Chunk 1 being green)

**Goal:** After this chunk, `any` violations, unused types, and cross-boundary imports all fail CI and the pre-commit hook. Zero silent warnings in the lint pipeline.

**Findings addressed:** Z02-01, Z02-08, Z02-09, Z02-11, Z02-13, Z02-16

Actions:

- Upgrade `'@typescript-eslint/no-explicit-any': 'warn'` → `'error'`. Fix the 3 non-test `as any` sites.
- Add `--max-warnings 0` to `lint-staged.config.js` ESLint invocation and per-package `"lint"` scripts.
- Add `import/no-extraneous-dependencies` rule to `eslint.config.js`.
- Add `pathGroups` for `@sym/**` → `internal` in `import/order`.
- Enable `noUnusedLocals: true` and `noUnusedParameters: true` in `tsconfig.base.json`.
- Add `knip` (dead export detection) as a root devDependency with a minimal `knip.json`; add `"knip": "knip"` to root `scripts` and a `knip` step to CI after `lint`.

---

### Chunk 3 — CI hygiene and DX improvements (no deps)

**Goal:** After this chunk, CI reads Node version from `.nvmrc`, turbo cache is not busted by `.env` edits, and `tests/**` is covered in all turbo task inputs. GitHub Actions are pinned to SHAs.

**Findings addressed:** Z02-06, Z02-07, Z02-12, Z02-19, Z02-20

Actions:

- Replace `node-version: '24'` with `node-version-file: '.nvmrc'` in `ci.yml`.
- Pin `actions/checkout` and `actions/setup-node` to full SHA tags; add Dependabot `github-actions` config.
- Add `dev/`, `tmp/`, `.claude/` to `.dockerignore`.
- Add `"tests/**"` to `lint` and `typecheck` task inputs in `turbo.json`.
- Remove `.env` and `.env.*` from `turbo.json` `globalDependencies`.

---

### Chunk 4 — OSS baseline (depends on Chunk 1)

**Goal:** After this chunk, the repo passes GitHub's community health checklist and a first-time contributor knows how to set up, test, and submit a change.

**Findings addressed:** Z02-18

Actions:

- Add `CONTRIBUTING.md`: clone → `pnpm install` → copy `.env.example` → `pnpm dev`, `pnpm test`, `pnpm typecheck`, PR checklist.
- Add `SECURITY.md`: responsible-disclosure email, scope note (this is a personal Slack bot, not a hosted service).
- (Optional) Add `.github/CODEOWNERS` assigning `@amitray` to `*`.
