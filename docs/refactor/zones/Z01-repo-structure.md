# Zone Z01: Repo structure & monorepo packaging

## Summary

The monorepo skeleton is well-formed and follows a clear three-tier convention
(`apps/*` → runtime, `packages/*` → shared libs, `packages/adapter/*` → platform
adapters). The dependency graph is acyclic and properly layered: `contracts` is
the leaf with no internal imports, `kernel` and `adapter-slack` both depend only
on `contracts`, and `apps/agent` imports all three. Turbo task ordering, TypeScript
compiler settings, and ESLint config are largely coherent. The main structural
problems are: (1) the README documents only `apps/agent + docs/` but the repo
has five additional first-class directories (`packages/`, `scripts/`, `slack/`,
`dokploy/`, `assets/`) that a newcomer will stumble on; (2) `commitlint`
scope-enum retains ~15 scopes from deleted features (DB, secrets, dashboard,
tasks, audit, etc.) that no longer exist, sending a confusing signal; (3) the
Turbo `dev` task has no `dependsOn`, so `pnpm dev` may start the agent against
stale compiled package artifacts; (4) `tsconfig.base.json` sets `composite: false`
which disables TypeScript project-references, leaving build ordering entirely to
Turbo; this is an intentional simplification but is undocumented; (5) the
`node:sqlite` Vitest workaround plugin in `apps/agent/vitest.config.ts` is
non-trivial and undocumented for contributor clarity; (6) `vitest` is declared as
a `devDependency` in all four packages separately rather than being hoisted to
the root; (7) the `pnpm-workspace.yaml` pattern requires a manual glob addition
for each new package category, which is a subtle maintenance trap; (8) stale
`.gitignore` entries for Drizzle/DB artifacts remain though no DB exists.
Overall the zone is healthy enough, but every item here will trip a first-time
contributor and should be cleaned before OSS launch.

---

## Findings

| ID     | Severity | Category    | Title                                                                                                                               | Files                                                         | Effort  |
| ------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------- |
| Z01-01 | high     | docs        | README layout section documents only apps/agent + docs                                                                              | README.md                                                     | trivial |
| Z01-02 | high     | dead-code   | commitlint scope-enum lists ~15 deleted-feature scopes                                                                              | commitlint.config.js                                          | trivial |
| Z01-03 | medium   | config      | turbo "dev" task has no dependsOn — starts agent against potentially stale dist                                                     | turbo.json                                                    | small   |
| Z01-04 | medium   | config      | composite:false in tsconfig.base.json undocumented — disables project refs                                                          | tsconfig.base.json                                            | trivial |
| Z01-05 | medium   | dx          | vitest node:sqlite workaround plugin is non-trivial and its comment-docs are in vitest.config.ts, not in a shared location          | apps/agent/vitest.config.ts                                   | trivial |
| Z01-06 | medium   | consistency | vitest duplicated in all four package devDependencies — should be hoisted to root                                                   | package.json, all package.jsons                               | small   |
| Z01-07 | medium   | config      | pnpm-workspace.yaml needs a new glob for every new package category                                                                 | pnpm-workspace.yaml                                           | small   |
| Z01-08 | low      | dead-code   | .gitignore contains stale Drizzle/DB entries (drizzle, drizzle-meta, \*.sqlite)                                                     | .gitignore                                                    | trivial |
| Z01-09 | low      | config      | turbo.json "test" and "lint" inputs include "test/\*\*" — no package uses this path                                                 | turbo.json                                                    | trivial |
| Z01-10 | low      | docs        | packages/contracts, kernel, adapter-slack lack "repository", "author", "description" metadata                                       | packages/\*/package.json, packages/adapter/slack/package.json | small   |
| Z01-11 | low      | config      | packages lack "sideEffects": false field — tree-shaking optimization for eventual publish                                           | packages/\*/package.json                                      | trivial |
| Z01-12 | low      | config      | turbo globalDependencies lists ".env" and ".env.\*" — busts all caches on any env change, including in CI                           | turbo.json                                                    | small   |
| Z01-13 | low      | dead-code   | commitlint.config.js has an example comment referencing "feat(db)" which no longer exists                                           | commitlint.config.js                                          | trivial |
| Z01-14 | low      | structure   | apps/agent tsconfig.json adds DOM lib for Ink/React — undocumented risk that server code can accidentally reference browser globals | apps/agent/tsconfig.json                                      | small   |
| Z01-15 | low      | consistency | Pi agent packages (@earendil-works/pi-\*) pinned to exact version 0.75.5 — no patch range means security fixes are blocked          | apps/agent/package.json                                       | small   |

---

## Detail

### Z01-01 — README layout section documents only apps/agent + docs (high, docs)

**Evidence:** `README.md:130–137`:

```
## Repository layout

\`\`\`
apps/
  agent/    Hono server — Slack events → Pi agent loop → Fireworks reply
docs/
  FUTURE.md Parked features (connectors, skills, DB, dashboard, audit, tasks)
\`\`\`
```

The actual repo root contains `packages/` (3 workspace packages), `scripts/`
(setup scripts + manifest render), `slack/` (Slack app manifest), `dokploy/`
(deploy config), and `assets/` (avatars). A contributor cloning the repo will
immediately see six directories not in the README.

**Recommendation:** Expand the layout section to include all first-class directories
with a one-line description. E.g.:

```
apps/agent        Hono server — Slack events → Pi agent loop → Fireworks reply
packages/contracts  Shared type definitions (zero runtime)
packages/kernel     Prompt builder + receipt formatter + tool registry
packages/adapter/slack  Slack API client + event normalizer + Block Kit renderer
scripts/          Dev-setup helpers + Slack manifest renderer
slack/            Slack app manifest template (commit manifest.template.yml, not manifest.yml)
dokploy/          Self-hosted deploy config (Dokploy / Coolify)
assets/           Bot avatar images
```

---

### Z01-02 — commitlint scope-enum lists ~15 deleted-feature scopes (high, dead-code)

**Evidence:** `commitlint.config.js:24–52`:

```js
'scope-enum': [1, 'always', [
  'repo', 'db', 'contracts', 'secrets',   // 'db' and 'secrets' removed
  'slack', 'kernel', 'fireworks', 'agent', 'dashboard', 'onboarding', // 'dashboard', 'onboarding' removed
  'mcp', 'skills', 'sandbox', 'memory', 'audit', 'tasks', 'soul',     // 'skills', 'sandbox', 'memory', 'audit', 'tasks', 'soul' removed
  'devex', 'ci', 'deps', 'docs', 'specs',
]],
```

Deleted features: `db`, `secrets`, `dashboard`, `onboarding`, `skills`,
`sandbox`, `memory`, `audit`, `tasks`, `soul`. These are still listed as valid
scopes. A contributor sees them as active features. The warning level `[1]`
also means violations are just warnings, not errors — reducing the value of
scope enforcement.

**Recommendation:** Remove all scopes that correspond to deleted features. Keep:
`repo`, `contracts`, `kernel`, `slack`, `fireworks`, `agent`, `mcp`, `devex`,
`ci`, `deps`, `docs`, `specs`. Consider raising to error level `[2]` so that
invalid scopes are actually enforced. Also remove the `feat(db)` example in the
file's leading comment.

---

### Z01-03 — turbo "dev" task has no dependsOn — stale dist on fresh clone (medium, config)

**Evidence:** `turbo.json:54–57`:

```json
"dev": {
  "cache": false,
  "persistent": true
}
```

`apps/agent` dev script is `tsx watch src/index.ts` which resolves
`@sym/contracts`, `@sym/kernel`, and `@sym/adapter-slack` via their `dist/`
symlinks (workspace:\*). On a fresh clone (or after `pnpm clean`), `dist/` does
not exist and the agent will fail at startup with a module-not-found error.

**Recommendation:** Add `"dependsOn": ["^build"]` to the `dev` task. This
ensures upstream packages are built before the persistent watcher starts. Since
packages have no watch mode, this is a one-time build before the agent dev
loop — the correct behaviour.

---

### Z01-04 — composite:false in tsconfig.base.json is undocumented (medium, config)

**Evidence:** `tsconfig.base.json:29`:

```json
"composite": false
```

`composite: false` prevents TypeScript project references (cross-package
`tsc --build` orchestration). In this monorepo Turbo handles build ordering,
so `composite` is intentionally off. But the setting is unexplained — a
contributor expecting standard monorepo project references will be confused.
Also, `declarationMap: true` and `declaration: true` are set (line 27–28),
which are typically paired with `composite: true`. They still work without it
(outputs declaration files and maps for IDE "go to source"), but the combination
looks accidental.

**Recommendation:** Add a comment above the `composite` field:

```
// Turbo orchestrates build order across packages; TypeScript project-references
// are not used. "incremental" still generates .tsbuildinfo for per-package
// speedup. "declaration" + "declarationMap" enable IDE "go to source" across
// workspace packages via their dist/ symlinks.
```

---

### Z01-05 — vitest node:sqlite workaround plugin lacks a discoverable home (medium, dx)

**Evidence:** `apps/agent/vitest.config.ts:6–54` — a 49-line Vite plugin
(`nodeNewBuiltinsPlugin`) is embedded directly in the vitest config. The
comment correctly explains the Vite 5 limitation. However, if a second package
ever needs the same workaround, the code would need to be copy-pasted. There
is no shared `scripts/` or `config/` location for this kind of reusable Vite
plugin.

**Recommendation:** This is acceptable as-is given only one package uses
`node:sqlite`. The finding is low-priority unless a second package adds
Node 24 built-ins. If it stays, add one line pointing to a hypothetical
shared location in the comment, so a future contributor knows where to move it.

---

### Z01-06 — vitest duplicated as devDependency in all four packages (medium, consistency)

**Evidence:**

- `packages/contracts/package.json:23`: `"vitest": "^2.1.8"`
- `packages/kernel/package.json:19`: `"vitest": "^2.1.8"`
- `packages/adapter/slack/package.json:19`: `"vitest": "^2.1.8"`
- `apps/agent/package.json:37`: `"vitest": "^2.1.8"`

All four use the exact same version range. pnpm hoists shared devDeps to the
root `node_modules` automatically, so there is no correctness issue. However,
the entry appears in all four `package.json` files, creating four places to
bump on a version upgrade. A contributor may also question why the root
`package.json` doesn't list it.

**Recommendation:** Move `vitest` to the root `devDependencies`. When a
devDependency is needed identically in every workspace member, the root is the
canonical location. Each package's `package.json` stays clean. (If a package
ever needs a different version range, it can override locally.)

---

### Z01-07 — pnpm-workspace.yaml glob pattern requires manual update per new category (medium, config)

**Evidence:** `pnpm-workspace.yaml:1–4`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'packages/adapter/*'
```

Adding a second adapter (e.g. `packages/adapter/github`) works correctly. But
adding a second category (e.g. `packages/extension/web`) requires a new
`'packages/extension/*'` line. The current `'packages/*'` glob does NOT pick
up `packages/extension/web` because `packages/extension` has no `package.json`.
A contributor adding a new nested package category could be confused when their
package isn't recognized as a workspace member.

**Recommendation:** Either (a) replace with `'packages/**'` (picks up all
nested packages automatically), or (b) add a comment explaining the convention:

```yaml
# Flat packages (singletons): packages/*
# Nested category packages: add one glob per category (e.g. packages/adapter/*)
# NOTE: intermediate directories (e.g. packages/adapter) must NOT have package.json
```

Option (b) is preferred if the team wants explicit control over the shape.

---

### Z01-08 — .gitignore contains stale Drizzle/DB entries (low, dead-code)

**Evidence:** `.gitignore:43–46`:

```
# Drizzle
drizzle/.snapshots
drizzle-meta

# Local dev databases
*.sqlite
*.sqlite3
*.db
```

No Drizzle files, migration directories, or ORM usage exist in the repo (the
DB was removed in the North Star collapse). The `*.sqlite` entry is still
valid because `mcp/store.ts` uses `node:sqlite` for OAuth token storage, but
`drizzle/.snapshots` and `drizzle-meta` are purely from the deleted DB layer.

**Recommendation:** Remove the `# Drizzle` block (`drizzle/.snapshots`,
`drizzle-meta`). Rename the comment for `*.sqlite` to `# MCP OAuth token store
(node:sqlite)` to explain why it remains.

---

### Z01-09 — turbo.json "test" and "lint" inputs include unused "test/\*\*" path (low, config)

**Evidence:** `turbo.json:23` (test task) and `turbo.json:34` (lint task):

```json
"test/**",
```

Every package in the repo uses `tests/` (plural). The `test/` path is never
created. This is a dead input that has no effect but misleads a contributor
about the expected test directory name.

**Recommendation:** Remove `"test/**"` from both the `test` and `lint`
`inputs` arrays. The repo convention (and `tsconfig.test.json` `include`
patterns) already canonicalize on `tests/`.

---

### Z01-10 — packages lack OSS metadata fields (low, docs)

**Evidence:** None of `packages/contracts/package.json`, `packages/kernel/package.json`,
or `packages/adapter/slack/package.json` contain `repository`, `author`,
`description`, `keywords`, or `homepage` fields.

The root `package.json` has `description` and `license` but no `repository`
or `author`.

**Recommendation:** Even for `"private": true` packages, these fields matter
for OSS launch: (a) tooling like Renovate/Dependabot uses `repository`; (b)
contributors expect to find authorship and a canonical URL. Add to root and each
package at minimum:

```json
"author": "Amit Ray",
"repository": { "type": "git", "url": "https://github.com/…/sym" },
"description": "…"
```

---

### Z01-11 — packages lack "sideEffects": false (low, config)

**Evidence:** None of `packages/contracts/package.json`, `packages/kernel/package.json`,
or `packages/adapter/slack/package.json` declare `"sideEffects"`.

`@sym/contracts` is pure types (zero runtime). `@sym/kernel` and
`@sym/adapter-slack` export only pure functions with no module-level side
effects. Without `"sideEffects": false`, bundlers (Rollup, esbuild, Vite)
cannot safely tree-shake any of these packages.

**Recommendation:** Add `"sideEffects": false` to all three library packages.
This is a no-op for the current use case (no bundling of the agent) but is
required hygiene for a publish-ready package.

---

### Z01-12 — turbo globalDependencies includes ".env" — busts all caches on env changes (low, config)

**Evidence:** `turbo.json:6–9`:

```json
"globalDependencies": [
  "tsconfig.base.json",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.*.example"
]
```

Any change to `.env` (e.g. rotating an API key) invalidates the entire Turbo
cache across all packages. In CI `.env` typically doesn't exist (secrets are
injected as process env), so the hash is stable there. But locally, rotating
`FIREWORKS_API_KEY` for example would force a full rebuild, which is unexpected
and slow.

**Recommendation:** Remove `.env` and `.env.*` from `globalDependencies`. Env
vars that affect build outputs (if any) should be listed in `globalEnv` instead.
If no env var actually affects build artifacts (correct for this codebase — env
vars are runtime only), then `globalDependencies` needs only `tsconfig.base.json`.
The current `globalEnv` of `["NODE_ENV", "CI"]` is already correct.

---

### Z01-13 — commitlint.config.js example comment references deleted "feat(db)" (low, dead-code)

**Evidence:** `commitlint.config.js:4`:

```js
 *   feat(db): add memory_entries table
```

The `db` scope and the `memory_entries` table no longer exist. This is the
first thing a contributor reads in the file.

**Recommendation:** Replace with a current-codebase example:

```js
 *   feat(mcp): add stdio connector support
 *   fix(slack): dedupe events by event_id
 *   chore(repo): bump turbo to 2.4
```

---

### Z01-14 — apps/agent tsconfig.json adds DOM lib — server code can accidentally reference browser globals (low, structure)

**Evidence:** `apps/agent/tsconfig.json:9–12`:

```json
"jsx": "react-jsx",
"lib": ["ES2023", "DOM"]
```

The comment (`// DOM is added for type resolution only`) is correct — Ink
(`@types/react`) requires `DOM` for its internal types. But this means all
TypeScript files in `apps/agent/src/` — including `server.ts`, `handle-turn.ts`,
etc. — can reference `document`, `window`, `fetch`, `Request`, `Response` etc.
without a compile error. This creates a latent risk where Node-specific server
code accidentally uses browser APIs.

**Recommendation:** Scope the DOM lib override to only the TUI files. One
approach: move `src/tui/` and `src/cli/` to a separate `tsconfig.tui.json`
that inherits from the base and adds `"lib": ["ES2023", "DOM"]`, while
`tsconfig.json` stays at `"lib": ["ES2023"]`. The build script would run both:
`tsc -p tsconfig.json && tsc -p tsconfig.tui.json`. This is a medium-effort
refactor and may not be worth it given Ink usage is isolated; flagged as low.

---

### Z01-15 — Pi packages pinned to exact version, blocking patch-level security fixes (low, consistency)

**Evidence:** `apps/agent/package.json:21–22`:

```json
"@earendil-works/pi-agent-core": "0.75.5",
"@earendil-works/pi-ai": "0.75.5",
```

Exact version pins (no `^` or `~`) mean Renovate/Dependabot will open a new PR
for each minor/patch update rather than satisfying within a range. More
importantly, if a security fix is published at `0.75.6`, it will NOT be
automatically satisfied.

**Recommendation:** Unless the Pi SDK has had breaking changes in patch
releases (making exact pinning intentional), change to `"^0.75.5"` to allow
compatible patch updates. If the exact pin is intentional (e.g. the SDK's
semver is unreliable), add a comment explaining why.

---

## Proposed chunks

Dependency-ordered. Each chunk is one working thing that leaves the repo in
a clean, buildable, green-CI state.

### C01 — Fix docs and dead config (Z01-01, Z01-02, Z01-08, Z01-09, Z01-13)

**Goal:** README accurately describes the repo layout; commitlint only lists
live scopes; .gitignore is clean; turbo test/lint inputs don't reference the
dead `test/` path; example comment in commitlint.config.js is updated.
**Files changed:** `README.md`, `commitlint.config.js`, `.gitignore`,
`turbo.json`.
**Depends on:** nothing.

### C02 — Fix turbo dev task and cache hygiene (Z01-03, Z01-12)

**Goal:** `pnpm dev` from a clean clone builds all packages before starting
the persistent agent watcher; `.env` changes no longer bust the entire turbo
cache.
**Files changed:** `turbo.json`.
**Depends on:** nothing.

### C03 — Add inline documentation to tsconfig.base.json and vitest.config.ts (Z01-04, Z01-05)

**Goal:** A contributor reading `tsconfig.base.json` immediately understands
why `composite: false` and why `incremental: true` coexist without project
references; `vitest.config.ts` node:sqlite workaround is self-contained and
clearly scoped.
**Files changed:** `tsconfig.base.json`, `apps/agent/vitest.config.ts`.
**Depends on:** nothing.

### C04 — Hoist vitest to root and add OSS metadata (Z01-06, Z01-10, Z01-11)

**Goal:** `vitest` appears only in root devDependencies; all library packages
have `repository`, `author`, `description`, `sideEffects: false`.
**Files changed:** `package.json`, `packages/contracts/package.json`,
`packages/kernel/package.json`, `packages/adapter/slack/package.json`.
**Depends on:** nothing (cosmetic; pnpm will hoist regardless).

### C05 — Document pnpm-workspace pattern and improve workspace discoverability (Z01-07)

**Goal:** The workspace yaml comment makes the nested-glob convention explicit
so contributors adding new categories know what to do.
**Files changed:** `pnpm-workspace.yaml`.
**Depends on:** nothing.

### C06 — Constrain DOM lib to TUI tsconfig (Z01-14) — OPTIONAL/DEFERRED

**Goal:** Server-side code in apps/agent cannot accidentally reference browser
globals at compile time.
**Files changed:** `apps/agent/tsconfig.json`, new `apps/agent/tsconfig.tui.json`.
**Depends on:** C03 (after tsconfig changes are documented, a follow-up
tsconfig split is easier to review).
**Note:** Only warranted if the team wants strict server/browser type
separation. Low risk in practice since all Ink usage is isolated to `src/tui/`.
