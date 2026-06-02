# TypeScript monorepo structure & packaging (OSS best practice)

Research date: 2026-06-02. Focus: pnpm + Turbo monorepos in the TypeScript/Node/ESM space —
specifically whether Sym's current split (`contracts` / `kernel` / `adapter/slack` +
`apps/agent`) reflects best practice, and what concrete changes would make it a better OSS
project.

---

## Key takeaways

1. **The packages/ split is only justified when code is actually shared across multiple
   consumers, or when independent cacheability provides measurable build-time wins.** For a
   single-app monorepo the conventional wisdom (Turborepo docs, tRPC, hsb.horse 2026 guide) is
   to start without packages and extract only when the code is genuinely reused or the
   extraction has a specific pay-off. Sym currently has _one_ app; every package is private and
   consumed by `@sym/agent` alone (37 cross-package imports total).

2. **Turborepo explicitly recommends _against_ TypeScript project references** (`composite:
true`) when using its own task orchestration — they add a second caching layer with no
   marginal gain. Sym's current `tsconfig.base.json` correctly uses `"composite": false`.

3. **The `exports` field is the correct package API surface.** Each compiled internal package
   should declare `{ "types": "./dist/index.d.ts", "default": "./dist/index.js" }`, plus
   `"sideEffects": false` for tree-shaking. Sym's packages already do the former; all are
   missing `"sideEffects": false`.

4. **JIT (Just-in-Time) packages** — pointing `exports` directly at `.ts` source files — are
   viable for internal packages consumed only by an `apps/` target that uses a bundler (Vite,
   webpack, Turbopack). They give instant "live types" and remove the per-package build step
   entirely. Sym's agent uses `tsc` alone (not a bundler), so JIT would not work as-is; the
   compiled strategy is correct.

5. **pnpm catalogs** (new in pnpm 9+, used by the MCP TS SDK) centralise shared dependency
   versions in `pnpm-workspace.yaml`. Sym has four packages that each install `vitest`
   independently; a catalog entry would make upgrades a single-line change.

6. **Knip** is the industry standard for dead-code + unused-export detection in TypeScript
   monorepos (used by Vercel to cut 300k lines). It is zero-config for pnpm workspaces +
   Turborepo + Vitest.

7. **Shared config packages** (`@repo/eslint-config`, `@repo/typescript-config`) are a
   Turborepo canonical pattern. Sym instead puts both at the root — which works and is simpler
   for a small repo, but means the root `package.json` carries all config devDependencies.

8. **`sideEffects` in package.json** needs to be set explicitly on any compiled internal
   package so downstream bundlers can tree-shake. Absence is a correctness gap for any future
   consumers.

9. **README repo layout section** must be accurate before open-sourcing. It currently lists
   only `apps/agent` + `docs/`; the live tree contains `packages/` (3 packages),
   `packages/adapter/`, `slack/`, `dokploy/`, `scripts/`, `assets/`, and `docs/refactor/`.

10. **`eslint-plugin-boundaries` or `dependency-cruiser`** can enforce the intended DAG
    (contracts → kernel/adapter, nothing should import back up). Without a rule, circular
    imports are silent until they break something.

---

## Reference repositories

| Repo                                                 | Lesson                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **vercel/turborepo** (docs + examples)               | Canonical `apps/` vs `packages/` convention; "always use package tasks, never root tasks for build logic"; lockfile mandatory; avoid nested wildcards in workspace globs; JIT vs compiled vs publishable package decision tree                              |
| **modelcontextprotocol/typescript-sdk**              | pnpm catalog for shared dep versions; root-level `pnpm-workspace.yaml` with `catalogs:` block; `"type": "module"`, Node >=20 engines; docs-generation scripts alongside test scripts                                                                        |
| **honojs/middleware**                                | Multi-package monorepo for middleware — each package under `packages/<name>/`; Turborepo for lint caching; tsdown for compilation; Changesets for versioning; Yarn 4 workspaces                                                                             |
| **slackapi/bolt-js**                                 | _Counter-example_: no `exports` field, no workspace — shows why the modern `exports` + workspace approach matters; useful contrast for an OSS Slack SDK                                                                                                     |
| **hsb.horse 2026 monorepo guide**                    | Recommends starting with `pnpm workspace + TypeScript Project References` before adding Turborepo; warns against `tsconfig.paths`-only setups; four-layer package taxonomy (core / ui / apps); environment-specific code must not leak into shared packages |
| **Colin McDonnell — Live types essay**               | Five patterns for "live" internal types during dev (project refs, publishConfig, tsconfig paths, tshy, custom export conditions); `publishConfig` pnpm-only; custom export conditions most portable                                                         |
| **Thijs Koerselman — Quest for perfect TS monorepo** | Argues compiled packages > JIT for production monorepos; each package should be a "self-contained unit"; tsc + `--emitDeclarationOnly` for declaration maps enabling IDE jump-to-source                                                                     |
| **knip.dev**                                         | Zero-config dead-code + unused-export scanner for pnpm workspaces; understands Vitest, Turborepo, ESLint; run `knip --production` to restrict to non-test code                                                                                              |
| **effectivetypescript.com — Use knip**               | Explains Knip's module-graph approach vs ESLint's file-local approach; must configure entry points correctly before `--fix`                                                                                                                                 |
| **pnpm catalogs docs**                               | `catalog:` protocol in `pnpm-workspace.yaml`; default catalog for a single version set; named catalogs for multi-version scenarios; single-line upgrades; no merge conflicts in lock file                                                                   |

---

## Sym-specific recommendations

The findings are ordered from highest-impact / most structural to low / polish.

### R1.1 — Justify or collapse `packages/kernel`

**Status: question for the team, evidence leans toward collapsing.**

`@sym/kernel` exports three things: `buildSystemPrompt`, `buildTurnContextPrompt`, `buildUserTurnContent` (prompt builders) and `buildReceipt` / `ToolRegistry`. It is imported in 8 places in `apps/agent/src` and by nobody else. It does not depend on `@sym/adapter-slack`. The split adds a build step and a package boundary with no shared consumer.

Best practice: extract a package when (a) two or more apps consume it, or (b) it is independently testable/versioned. Neither applies here.

**Recommendation**: fold `packages/kernel/src/*` into `apps/agent/src/kernel/` (a module folder, not a package). Delete `packages/kernel/`. Update the 8 import sites. This is a mechanical refactor — zero logic change.

If the team explicitly wants kernel to remain isolated for testing or future reuse, keep it, but add a comment in its `package.json` explaining why.

### R1.2 — Justify or collapse `packages/contracts`

**Status: justified but could be lighter.**

`@sym/contracts` is pure types (`export type *` everywhere), zero runtime. It is imported by `@sym/adapter-slack`, `@sym/kernel`, and `apps/agent` — so it does have multiple consumers. This is the canonical reason to extract a package.

However, a pure-types package still requires a build step (`tsc`) to emit `.d.ts` files. An alternative is to use the JIT / live-types pattern: point `exports` at the `.ts` source directly. Because `@sym/contracts` has no runtime code, there is nothing to transpile. The consuming app/packages' own `tsc` builds will resolve the types from source.

**Recommendation (option A — keep as-is)**: the current compiled approach is correct and safe. No change needed beyond adding `"sideEffects": false` (see R1.5).

**Recommendation (option B — go JIT)**: change `exports` to:

```json
{
  ".": {
    "types": "./src/index.ts",
    "default": "./src/index.ts"
  }
}
```

Remove the `build` script and `dist` output. This works because the package is type-only and all consumers already run `tsc`. This saves a build layer and lets types update instantly without a rebuild cycle. The downside: `dist/` disappears, so any future external consumer would need to compile the package themselves.

### R1.3 — Evaluate `packages/adapter/slack` placement

**Status: the grouping `packages/adapter/<name>` is correct convention; the package content is justified.**

`@sym/adapter-slack` wraps Slack-specific concerns (signature verification, Block Kit rendering, thread fetching, receipt formatting). It is imported in 15 places in `apps/agent/src` and by nobody else — same single-consumer pattern as `@sym/kernel`.

However, there is a meaningful architectural argument for keeping it separate: it is the **seam between Slack's API and Sym's domain**. If Sym were ever extended to support a second platform (Teams, Discord), the adapter boundary becomes important. The `packages/adapter/<name>` grouping correctly anticipates this.

**Recommendation**: keep `packages/adapter/slack` as-is. Document the intent (seam / potential multi-platform boundary) in the package's README or `package.json` description. Add `"sideEffects": false`.

### R1.4 — Add `"sideEffects": false` to all compiled internal packages

All three packages (`@sym/contracts`, `@sym/kernel`, `@sym/adapter-slack`) are missing this field. Without it, bundlers (Vite, webpack, esbuild) cannot tree-shake unused exports.

**Action**: add to each package's `package.json`:

```json
"sideEffects": false
```

This is a one-liner per package and has no downside (none of the packages register global side effects).

### R1.5 — Add `pnpm catalogs` for shared devDependencies

Currently `vitest` (`^2.1.8`) is pinned identically in four separate `package.json` files. When upgrading, all four must be updated by hand.

**Action**: add a `catalog:` block to `pnpm-workspace.yaml`:

```yaml
catalog:
  vitest: ^2.1.8
```

Then replace each `"vitest": "^2.1.8"` with `"vitest": "catalog:"`. The MCP TS SDK uses this pattern across its workspace packages.

Consider cataloging `typescript` and `@types/node` as well (both are currently pinned in the root but not in sub-packages).

### R1.6 — Adopt `knip` for dead-code detection before open-source launch

Given the known concerns about AI-generated cruft (TUI screens, CLI secrets store, admin-client) and the oversized files (`builtin-tools.ts` 1679 lines, `handle-turn.ts` 1057 lines), a Knip run would surface unused exports and dead files mechanically.

**Action**:

1. `pnpm add -Dw knip`
2. Run `pnpm knip` from the root (Knip auto-detects pnpm workspaces, Vitest, Turborepo, and ESLint).
3. Run `pnpm knip --production` to restrict analysis to non-test code.
4. Triage the report before any fix pass — Knip can flag live code if entry points are misconfigured.

Add `knip` to the root `scripts` and optionally as a CI step (`knip --no-exit-code` to not block CI during initial adoption).

### R1.7 — Enforce package boundary rules via `eslint-plugin-boundaries`

The intended dependency DAG is:

```
@sym/contracts  (no deps)
    ↓
@sym/kernel, @sym/adapter-slack  (depend on contracts only)
    ↓
@sym/agent  (depends on all three)
```

Nothing enforces this today. A transitive circular import would be invisible until runtime.

**Action**: add `eslint-plugin-boundaries` to the root ESLint config with rules that:

- Disallow `@sym/kernel` or `@sym/adapter-slack` from importing `@sym/agent`
- Disallow `@sym/contracts` from importing anything in the `@sym/` scope

This is lighter than `dependency-cruiser` (which requires a separate config file and is better suited to large teams with complex graphs). For Sym's three-layer DAG, a few `eslint-plugin-boundaries` rules suffice.

### R1.8 — Fix README repository layout to match reality

The README's `## Repository layout` section lists only:

```
apps/
  agent/
docs/
  FUTURE.md
```

The actual tree includes `packages/` (3 packages), `packages/adapter/slack`, `slack/` (app manifest), `dokploy/` (deployment config), `scripts/` (setup + manifest render), and `assets/`.

**Action**: update the README before open-sourcing to reflect the actual structure. Include a one-line description of each top-level directory. Newcomers will immediately notice if the documentation does not match the directory listing.

### R1.9 — Consider shared config packages only if the repo grows

Turborepo's own examples use `packages/eslint-config` and `packages/typescript-config` as shared packages. For Sym's current size (one app, three packages), the root-level `eslint.config.js` + `tsconfig.base.json` approach is simpler and just as correct.

**Recommendation**: do not create shared config packages now. If Sym ever gains a second app (e.g. a CLI app in `apps/sym-cli`), extract config packages at that point. Until then, root-level config is the right call.

### R1.10 — Turbo task pipeline is correct; one improvement for `test`

The current `turbo.json` has `test.dependsOn: ["^build"]`, meaning tests always wait for upstream package builds. This is correct for compiled packages.

One potential improvement: add a `typecheck` task that uses `"dependsOn": ["^typecheck"]` with `outputs: ["*.tsbuildinfo"]` so incremental type-checking is cached independently from full builds. Sym already has the `typecheck` task but its `dependsOn: ["^build"]` means it waits for a full build of dependencies — for type-only packages like `@sym/contracts`, this is wasteful.

**Action** (low priority): change `typecheck.dependsOn` from `["^build"]` to `["^typecheck"]` and ensure each package's `tsconfig.test.json` / `typecheck` script emits a `.tsbuildinfo` that Turbo can cache.

---

## What Sym gets right (do not change)

- `"type": "module"` + `"module": "NodeNext"` + `"moduleResolution": "NodeNext"` + `verbatimModuleSyntax` — this is the current gold standard for Node.js ESM.
- `"composite": false` in `tsconfig.base.json` — correctly defers to Turbo's own caching.
- Per-package `vitest.config.ts` files with explicit `include: ['tests/**/*.test.ts']` — matches Turborepo's recommended per-package test strategy.
- Tests in `tests/` subdirectories (not co-located) — consistent with stated convention.
- `pnpm-workspace.yaml` with explicit paths including `packages/adapter/*` — correct for a grouped adapter structure.
- `eslint-config-prettier` last in the ESLint flat config array — correct.
- `no-console: ["warn", { allow: ["warn", "error", "info"] }]` in ESLint — enforces the `console.log`-is-forbidden-on-server convention.
- `import/order` with `alphabetize` — clean import hygiene.
- Husky + lint-staged + commitlint — standard OSS commit discipline.
- `"private": true` on all packages — prevents accidental `npm publish`.
