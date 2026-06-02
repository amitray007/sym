# TypeScript code-quality & anti-AI-slop tactics

Research date: 2026-06-02. Covers 2024-2026 practice.

---

## Key Takeaways

1. **File size is the most reliable proxy for hidden complexity.** ESLint's `max-lines` rule (warn at 300, error at 500) is the lowest-effort gate that catches files that have grown into de-facto god-objects. Sym already has four files above 500 lines (`builtin-tools.ts` 1679, `handle-turn.ts` 1057, `server.ts` 804, `pi/loop.ts` 734). These are the primary refactor targets.

2. **Cyclomatic complexity and cognitive complexity measure different things; enforce both.** `complexity` (cyclomatic, built into ESLint) measures branching paths — good for detecting spaghetti flow. Biome's `noExcessiveCognitiveComplexity` measures mental effort — better at catching deeply nested callbacks and chained conditions even in short functions. Use both: cyclomatic max 15 (warn), cognitive max 15 (Biome `nursery`).

3. **Barrel files (`index.ts` that only re-exports) are the primary cause of import-graph sprawl and slow build times.** Atlassian removed barrel files from a 90k-file monorepo and cut CI build minutes by 75%, local TS highlighting by >30%, and unit test time by 50%. The rule of thumb: a `packages/*/src/index.ts` that exposes the package's public API is legitimate; an `index.ts` that re-exports 20 internal modules without adding any logic is slop. `eslint-plugin-no-barrel-files` enforces this in ESLint 9 flat config with one line.

4. **`knip` is the authoritative dead-code detector for TypeScript monorepos.** It traces the full import graph and reports unused files, unused exports, and unused dependencies simultaneously — the three failure modes that accumulate silently in AI-assisted development. It understands `pnpm-workspace.yaml` natively and needs near-zero config for a turbo+pnpm repo.

5. **`dependency-cruiser` enforces architectural layer rules as code.** The critical Sym rule: `packages/*` must never import from `apps/*`. Secondary rule: no circular dependencies (`to: { circular: true }`). Both are expressible in five lines of config and run in CI without a separate service.

6. **The "one file per tool" registry pattern scales to any number of tools.** `builtin-tools.ts` at 1679 lines contains 18 tool descriptors, their handler implementations, and helper functions — all in one file. The OSS convention (seen in oclif, Rush's `@rushstack/ts-command-line`, Vercel's AI SDK, and the MCP SDK itself) is: one file per logical unit (tool/command), a thin index that auto-discovers them, and a shared types file. This makes each tool independently testable and easy to locate.

7. **`no-restricted-imports` is ESLint's built-in layer enforcer.** Without adopting dependency-cruiser, you can approximate the same guarantee by adding a `files: ['packages/**']` override that restricts `@sym/adapter-slack`, `@sym/kernel`, and `@sym/contracts` from ever importing `../../../apps/**`. This is already expressible in Sym's existing `eslint.config.js` structure.

8. **Biome 2.x (released June 2025) is the performance-optimal linter for a new OSS project, but ESLint+typescript-eslint is the safe migration path for an existing one.** Biome is 20-56x faster, covers ~85% of typescript-eslint's rule set, and ships its own formatter. The risk: some rules Sym uses (`import/order`, `import/no-duplicates`) have no Biome equivalent yet. Recommendation: keep the current ESLint setup, add the missing quality rules to it, and defer the Biome migration to a later OSS-polish pass.

9. **`jscpd` catches copy-paste duplication that no static type checker will find.** AI code generators produce the highest duplication rates of any developer tool. A 5-minute `npx jscpd src --min-lines 8 --threshold 3` run on Sym's `apps/agent/src` will surface whether `builtin-tools.ts` contains repeated handler boilerplate that should be a shared helper.

10. **Max-params (4) and max-depth (4) rules catch the two most common AI-slop signatures.** AI generators frequently produce functions with 7-10 positional parameters (instead of an options object) and deeply nested `if/for/if/for` structures (instead of early returns and extracted helpers). Both are fast to lint, cheap to enforce, and hard to write accidentally.

---

## Reference Repositories

| Repository                                                                                                                               | Specific lesson to copy                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[typescript-eslint/typescript-eslint](https://github.com/typescript-eslint/typescript-eslint)**                                        | Uses `tseslint.configs.strictTypeChecked` + `tseslint.configs.stylisticTypeChecked`. Their own `eslint.config.ts` forbids `no-explicit-any` as an error (not warn). Exemplar for ESLint 9 flat config in a TypeScript monorepo.                                                                                                                 |
| **[webpro-nl/knip](https://github.com/webpro-nl/knip)**                                                                                  | Eats its own dog food — the knip repo is configured with `knip.json` for zero-tolerance dead exports. Copy their workspace configuration pattern and CI step (`knip --no-exit-code` for reporting, `knip` for hard fail).                                                                                                                       |
| **[sverweij/dependency-cruiser](https://github.com/sverweij/dependency-cruiser)**                                                        | The generated `.dependency-cruiser.js` from `npx depcruise --init` is the best starting config. Their `no-circular`, `no-orphans`, `no-unreachable-from-root`, and `not-to-dev-dep` rules cover 80% of what Sym needs.                                                                                                                          |
| **[biomejs/biome](https://github.com/biomejs/biome)**                                                                                    | Uses its own `.biome.json` for all formatting + linting. The `complexity.noExcessiveCognitiveComplexity` rule (threshold 15) and `complexity.noExcessiveLinesPerFunction` are the two complexity gates worth copying into any linter config.                                                                                                    |
| **[oclif/oclif](https://oclif.io/docs/introduction/)**                                                                                   | Per-file command pattern: `src/commands/foo.ts` contains exactly one command class, exported as default. The framework auto-discovers commands by walking the `commands/` directory. This is the direct model for splitting `builtin-tools.ts` into `src/tools/foo.ts` files with a `src/tools/index.ts` registry.                              |
| **[microsoft/rushstack](https://github.com/microsoft/rushstack)**                                                                        | `@rushstack/ts-command-line` uses a scaffold pattern with one `FooAction` class per file, all registered in a central `MyCommandLineParser`. Their pattern separates descriptor (metadata) from implementation (handler) in two exports per file — matches what `builtin-tools.ts` already does in spirit, but spread across one file per tool. |
| **[atlassian.com — barrel file removal](https://www.atlassian.com/blog/atlassian-engineering/faster-builds-when-removing-barrel-files)** | Authoritative case study: 75% build-time reduction by removing barrel files. Strategy: use a fixable ESLint rule (`eslint-plugin-no-barrel-files`) + automated `--fix` pass to migrate en masse. The key insight: 80% of a codebase is dormant at any time, so you can migrate in waves without conflicts.                                      |
| **[art0rz/eslint-plugin-no-barrel-files](https://github.com/art0rz/eslint-plugin-no-barrel-files)**                                      | Simplest ESLint 9 flat config integration: `import noBarrelFiles from 'eslint-plugin-no-barrel-files'; export default [...noBarrelFiles.configs.recommended]`. Zero configuration options needed.                                                                                                                                               |
| **[kucherenko/jscpd](https://github.com/kucherenko/jscpd)**                                                                              | Copy-paste detector with JSON reporter. The `--threshold 3` flag makes CI fail if duplication exceeds 3%. Their `.jscpd.json` config pattern (with `ignore` glob for `dist/` and `tests/fixtures/`) is directly copyable.                                                                                                                       |
| **[crazy4groovy/monorepo-template](https://github.com/crazy4groovy/monorepo-template)**                                                  | pnpm+turborepo+knip monorepo template. Study their `knip.config.ts` workspace pattern — especially how they configure `entry` per workspace and handle plugin auto-detection for vitest.                                                                                                                                                        |

---

## Recommendations for Sym

Each item is concrete and independently actionable. Items are ordered by highest leverage first.

### 1. Add `max-lines` and `max-lines-per-function` to `eslint.config.js`

The current ESLint config has no file-size or function-size guard. Add these to the `rules` object in the main TypeScript block:

```js
// In eslint.config.js, inside the rules: {} block for '**/*.{ts,tsx,...}'
'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
'complexity': ['warn', { max: 15 }],
'max-depth': ['warn', 4],
'max-params': ['warn', 4],
```

Set these as `warn` initially — this surfaces the violations without breaking CI. Promote to `error` once the four oversized files are refactored.

**Files currently violating max-lines (400):** `builtin-tools.ts` (1679), `handle-turn.ts` (1057), `server.ts` (804), `pi/loop.ts` (734), `mcp/dispatcher.ts` (652), `slack-client.ts` (570), `name-resolver.ts` (454), `packages/adapter/slack/src/client.ts` (520), `packages/adapter/slack/src/normalize.ts` (330).

### 2. Add `knip` for dead-code detection

Install and configure `knip` as a dev dependency at the repo root. The pnpm workspace is auto-detected from `pnpm-workspace.yaml`. Minimal `knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "workspaces": {
    ".": {
      "entry": ["scripts/*.{js,ts}"],
      "project": ["scripts/**/*.ts"]
    },
    "apps/agent": {
      "entry": ["src/index.ts", "src/server.ts"],
      "project": ["src/**/*.ts"]
    },
    "packages/contracts": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    },
    "packages/kernel": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    },
    "packages/adapter/slack": {
      "entry": ["src/index.ts"],
      "project": ["src/**/*.ts"]
    }
  },
  "ignore": ["**/dist/**", "**/tests/fixtures/**"]
}
```

Add to `turbo.json` tasks:

```json
"knip": {
  "inputs": ["src/**", "knip.json", "package.json"],
  "outputs": [],
  "cache": false
}
```

Add to root `package.json` scripts: `"knip": "knip"`. Run `npx knip` once to baseline the current violations before adding to CI.

### 3. Enforce import-layer boundaries with `no-restricted-imports`

Add a per-workspace ESLint override in `eslint.config.js` to enforce the architectural rule that `packages/*` cannot import from `apps/*`:

```js
// Add after the main TS rules block, still in eslint.config.js
{
  files: ['packages/**/*.{ts,tsx,mts,cts}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['*/apps/*', '../../../apps/*', '../../apps/*'],
            message: 'Packages must not import from apps. Invert the dependency.',
          },
        ],
      },
    ],
  },
},
```

This enforces the North Star architecture rule without adding a new tool.

### 4. Add `dependency-cruiser` for circular-dependency and orphan detection

Install `dependency-cruiser` and run `npx depcruise --init` to generate a `.dependency-cruiser.js`. Then add the following rules to the generated config's `forbidden` array:

```js
// In .dependency-cruiser.js
{
  name: 'no-circular',
  severity: 'error',
  comment: 'Circular dependencies break tree-shaking and cause hard-to-diagnose init ordering bugs.',
  from: {},
  to: { circular: true },
},
{
  name: 'no-orphans',
  severity: 'warn',
  comment: 'Orphaned modules are likely dead code — either delete them or wire them in.',
  from: { orphan: true, pathNot: ['\\.d\\.ts$', '^(src/index\\.ts|src/server\\.ts)$'] },
  to: {},
},
{
  name: 'packages-not-to-apps',
  severity: 'error',
  comment: 'Packages must not depend on apps — this inverts the dependency graph.',
  from: { path: '^packages/' },
  to: { path: '^apps/' },
},
```

Add a turbo task and `package.json` script: `"depcruise": "depcruise apps packages --include-only '^(apps|packages)' --config .dependency-cruiser.js"`.

### 5. Split `builtin-tools.ts` into a `src/tools/` registry

`builtin-tools.ts` (1679 lines, 18 tools) is the single biggest structural problem. The oclif and rushstack pattern: one file per tool, thin index that registers them all.

Target layout:

```
apps/agent/src/tools/
  index.ts                   ← re-exports createBuiltinDispatcher() only
  registry.ts                ← ALL_BUILTIN_DESCRIPTORS, createBuiltinDispatcher()
  get-current-time.ts        ← descriptor + handler (≈ 30 lines)
  read-channel.ts
  read-thread.ts
  read-user-profile.ts
  fetch-url.ts
  web-search.ts
  run-cli.ts
  list-channels.ts
  post-as-owner.ts
  react-as-owner.ts
  set-status.ts
  add-reminder.ts
  search-messages.ts
  delete-message.ts
  set-plan.ts
  update-task.ts
  present-card.ts
  present-table.ts
  _helpers.ts                ← dedupeSearchMatches, stripHtmlToText, coerce* helpers
```

Each tool file exports `{ descriptor, handler }` (or a named export matching the tool name). `registry.ts` imports them all and builds the `DESCRIPTORS_BY_NAME` map and `createBuiltinDispatcher`. This makes each tool independently unit-testable at `tests/tools/read-channel.test.ts` and eliminates the single-file scroll problem.

### 6. Add `jscpd` for copy-paste detection

Add a `.jscpd.json` at the repo root and a `scripts` entry:

```json
{
  "$schema": "https://raw.githubusercontent.com/kucherenko/jscpd/master/packages/jscpd/src/jscpd-schema.json",
  "minLines": 8,
  "minTokens": 50,
  "threshold": 5,
  "ignore": ["**/dist/**", "**/node_modules/**", "**/tests/fixtures/**", "**/*.d.ts"],
  "reporters": ["console", "json"],
  "output": "tmp/jscpd"
}
```

Run `npx jscpd apps packages` before the refactor to baseline duplication level. Target: below 3% after the `builtin-tools.ts` and `handle-turn.ts` refactors.

### 7. Add the `no-barrel-files` ESLint rule for internal modules

Sym's `packages/*/src/index.ts` files are legitimate public-API barrel files. The problem is _internal_ barrel files inside `apps/agent/src/mcp/index.ts` that just re-export from sibling files for no reason. Add to `eslint.config.js`:

```js
import noBarrelFiles from 'eslint-plugin-no-barrel-files';

// Inside the main TS files block, alongside other plugins:
plugins: {
  // ... existing plugins ...
  'no-barrel-files': noBarrelFiles,
},
rules: {
  // ... existing rules ...
  // Allow package-level index.ts files; flag internal ones
  'no-barrel-files/no-barrel-files': ['warn'],
},
```

Then add a specific override to _allow_ the public-API barrel files:

```js
{
  files: ['packages/*/src/index.ts', 'packages/*/*/src/index.ts'],
  rules: { 'no-barrel-files/no-barrel-files': 'off' },
},
```

### 8. Add Biome's cognitive complexity rule (without migrating away from ESLint)

Install `@biomejs/biome` as a dev dependency and add a `biome.json` with only the complexity rules enabled (all formatting rules off — Prettier handles that):

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "formatter": { "enabled": false },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": false,
      "complexity": {
        "noExcessiveCognitiveComplexity": {
          "level": "warn",
          "options": { "maxAllowedComplexity": 15 }
        },
        "noExcessiveLinesPerFunction": "warn"
      }
    }
  },
  "files": {
    "ignore": ["**/dist/**", "**/node_modules/**"]
  }
}
```

Add `"biome": "biome check apps packages"` to the root `package.json` scripts and a matching turbo task. This adds cognitive complexity coverage that ESLint's `complexity` rule misses (e.g., nested ternaries and optional-chaining chains).

### 9. Add a CI quality gate step in `.github/workflows/`

The current CI pipeline (inferred from turbo tasks) runs `lint`, `typecheck`, `test`, `build`. Add two new steps:

```yaml
- name: Dead code (knip)
  run: pnpm knip

- name: Circular deps (dependency-cruiser)
  run: pnpm depcruise
```

These run fast (5-15 seconds each) and catch the two most common AI-slop regressions: unused exports accumulating and circular imports forming.

### 10. Tighten existing `@typescript-eslint/no-explicit-any` from `warn` to `error`

The current config has `'@typescript-eslint/no-explicit-any': 'warn'`. In an OSS codebase, `any` in public-facing package types degrades the value of the type system for downstream consumers. Promote to `error` for `packages/**` specifically:

```js
{
  files: ['packages/**/*.{ts,tsx,mts,cts}'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
  },
},
```

Leave `apps/agent/src` at `warn` for now — the `handle-turn.ts` and `pi/loop.ts` refactors will eliminate the legitimate `any` usages there.

---

## Summary: Recommended quality gate additions (in priority order)

| #   | Action                                                         | Tool          | Effort | Impact                                               |
| --- | -------------------------------------------------------------- | ------------- | ------ | ---------------------------------------------------- |
| 1   | Add `max-lines`, `complexity`, `max-depth`, `max-params` rules | ESLint        | 10 min | Makes all oversized files visible in lint output     |
| 2   | Install and configure `knip`                                   | knip          | 20 min | Finds dead exports/files from AI-generated cruft     |
| 3   | Add `no-restricted-imports` for layer boundaries               | ESLint        | 10 min | Enforces packages-cannot-import-apps architecturally |
| 4   | Install and configure `dependency-cruiser`                     | depcruise     | 30 min | Prevents circular deps and finds orphans             |
| 5   | Split `builtin-tools.ts` into `src/tools/`                     | Refactor      | 2-3 hr | Removes the single largest structural violation      |
| 6   | Add `jscpd` baseline and CI gate                               | jscpd         | 15 min | Catches copy-paste duplication early                 |
| 7   | Add `no-barrel-files` rule                                     | ESLint plugin | 10 min | Prevents internal barrel files from creeping back    |
| 8   | Add Biome cognitive complexity check                           | Biome         | 20 min | Catches deeply-nested logic ESLint complexity misses |
