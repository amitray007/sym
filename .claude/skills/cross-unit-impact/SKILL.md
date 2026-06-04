---
name: cross-unit-impact
description: Use whenever changing a contract type, shared interface, or any package consumed by multiple units in Sym. Forces you to think through how every other unit reacts to the change, with production-grade migration discipline drawn from how Stripe, Shopify, Linear, Honeycomb, GitHub, and DHH-style Rails shops manage live systems. Run BEFORE writing the change and again before opening the PR.
---

# Cross-Unit Impact Discipline

**Core principle:** every change is a multi-unit change. The unit you're editing is never the only unit affected. Before touching code, name every other unit that reacts to this change, and design the change so all of them remain working at every intermediate state — including a half-deployed state, and a rolled-back state.

This skill exists because Sym is a pnpm monorepo with a layered package graph.
`@sym/contracts` has three consumers (`@sym/kernel`, `@sym/adapter-slack`,
`@sym/agent`). Interface changes that look local to one package are global.
Type changes that look local are global. The single deployable means there
is no database schema migration to coordinate, but there is a build graph to
keep acyclic and a public surface contract to keep intentional.

> **Architecture context.** Sym has two tiers: a stateless _conversational_
> tier (no message DB; Slack thread is the memory) and an intentional
> _local-state control_ tier (operator TUI/CLI + AES-256-GCM SQLite credential
> store). There is no Postgres, no web dashboard, no second service. "Schema
> change" in this skill means TypeScript contract changes in `@sym/contracts`,
> changes to the encrypted credential store's table shape, or changes to the
> connector config file format — not a relational migration.

---

## The checklist — run BEFORE editing

For the change you're about to make, answer these in order. If you can't answer cleanly, stop and redesign.

### 1. What units consume this?

List every package or external integration that reads or writes the thing you're
changing. Be specific. "Everyone" means you haven't thought about it.

- Contract type change → list every package that imports the type (use
  `pnpm typecheck` after the change; the compiler names the callers)
- `@sym/contracts` change → all three consumers: `@sym/kernel`,
  `@sym/adapter-slack`, `@sym/agent`
- Credential store schema change → `mcp/store.ts` is the only writer/reader;
  but the on-disk `credentials.db` lives on the `/data` volume in production —
  any breaking table change needs a migration or a version guard
- Connector config file format change → `mcp/source.ts` (reader) +
  `mcp/cli-config.ts` (cli section reader) + `sym apply` flow
- HTTP API change (`/admin/*`) → `cli/admin-client.ts` is the sole consumer
- Behavior change → list every caller relying on the old behavior

### 2. Is the change backward compatible?

A change is backward compatible if old consumers keep working unchanged after the change ships. The test:

- Old code + new schema → still works?
- New code + old schema → still works (for rollback)?

If both: green. Ship in one deploy.

If only one direction: this is an **expand-contract** migration. You need at least two deploys.

If neither direction: you're proposing a coordinated breaking change. Document the deploy choreography or redesign.

### 3. What's the expand-contract plan?

For any non-backward-compatible change, write down the three phases:

- **Expand** — add the new shape alongside the old. Both work. Writers dual-write or new field is optional. Deploy this. Verify in production.
- **Migrate** — backfill data, switch readers/writers to the new shape one at a time. Each step is independently deployable and rollbackable.
- **Contract** — remove the old shape only after every consumer has moved AND has been stable for a measured grace period.

Stripe API versioning, gh-ost online schema changes, Shopify's "one-deploy-compatible" rule, and the Square Sake migration framework all converge on this pattern. There is no better way.

### 4. What's the deploy order?

Sym is a single deployable (`apps/agent`). There is no second service to
coordinate. Deployment order is usually "build, push, restart." State it
explicitly anyway when a credential store schema change or config file format
change is involved — those affect the on-disk `/data` volume which persists
across redeploys.

- Credential store schema change → does the new code handle a pre-migration DB?
  (It must: the volume survives redeploy; the new binary boots against the old
  schema before any migration code runs.)
- Config file format change → does `mcp/source.ts` handle old-format files
  gracefully, or does it need a version gate?

If the answer is "no persistent state affected — redeploy is safe," write that
down in the PR.

### 5. What's the rollback plan?

For every change, the rollback story must exist. Write it in the PR:

- "Revert PR + redeploy" is valid if no persistent state was affected.
- For credential store schema changes: rollback usually means reverting the code
  and leaving the table shape in place. Plan for the old binary seeing the new
  schema (or vice versa) on a fresh redeploy.
- For config file format changes: old config files on `/data` will be read by
  the new binary — ensure the reader handles both formats or bumps the
  `version` field with a fallback path.
- For type-only changes in `@sym/contracts`: rollback is the inverse PR;
  track all three consumers.

Honeycomb's rule: "if you can't rollback, you can't deploy."

### 6. What audit + observability does this need?

If the change introduces new behavior:

- Does the new path emit `console.info` / `console.warn` / `console.error` log
  lines prefixed with `logCtx(turnId)` so concurrent turns are distinguishable?
  (Server code must never use `console.log` — CI-enforced.)
- Is the new behavior observable in `sym status --json` or the TUI dashboard
  when relevant (e.g., a new connector state, a new CLI capability)?
- Is there a metric or log line that signals when the change misbehaves in
  production without requiring a debugger?

Adding observability after the fact is 10× the work. Bake it into the same PR.

### 7. What eval changes?

For changes touching prompt assembly, system-prompt content, or anything
model-behavior-shaped:

- Does `packages/kernel/src/prompt.ts` (`buildSystemPrompt`,
  `buildUserTurnContent`) need updating?
- Does the change affect the model's tool-call behavior in a way that should be
  tested end-to-end (e.g., a new tool descriptor, a changed `destructiveHint`)?
- Run `pnpm test:integration` — the real-wire MCP/HTTP tests cover the turn loop.

### 8. What's the contract surface?

If your change touches `@sym/contracts`:

- All consuming packages updated in the same PR, OR
- Field added as optional, old usage tagged `@deprecated`, removed in a later PR
- No "we'll fix consumers in a follow-up." That's two PRs masquerading as one.

---

## Credential store schema subroutine

The encrypted SQLite credential store (`mcp/store.ts`, `credentials.db`) is the
highest-blast-radius persistent state in Sym. Run this whenever the table shape
or serialization format changes:

1. **Additive only by default.** New tables, new nullable columns — generally
   safe. Never add a `NOT NULL` constraint in the same change that adds the
   column; add nullable first, then tighten in a follow-up.
2. **Drops are two-phase.** Stop writing to the old column → redeploy → verify →
   drop. The volume persists across redeploys; a one-step drop breaks the running
   binary before it restarts.
3. **Renames are three-phase.** Add new column → dual-write → switch readers →
   drop old.
4. **The `DatabaseSync` constructor runs at boot** in `mcp/store.ts`. Any schema
   migration code that runs there must be idempotent (safe to re-run if the
   process restarts mid-migration).
5. **Schema change is reviewed independently of feature code.** The table DDL
   gets its own PR section.
6. **Test with `:memory:` and with a real file.** `mcp/store.ts` accepts
   `:memory:` for tests; ensure the migration path is exercised against both.

For `@sym/contracts` type changes (no DB): the expand-contract discipline in
§"What's the expand-contract plan?" above applies directly — old shape
stays until all three consumers are updated in the same PR.

---

## What top developers do, condensed

- **Stripe** — date-based API versions, server-side translation, never silent break. Apply: when `@sym/contracts` evolves, mark old shapes deprecated with a removal date, don't surprise consumers.
- **Shopify** — every deploy backward + forward compatible for at least one prior deploy. Apply: rollback to yesterday's binary must keep working with today's on-disk state (credential store, config file on `/data`).
- **Linear / cross-repo coordination** — bot opens PRs in every consumer; nothing merges until all green. Apply: when changing `@sym/contracts`, the same PR touches every consumer package — turbo's affected graph is your friend.
- **Honeycomb / deploy ordering** — explicit, documented, rehearsed. Apply: PR description lists deploy steps and rollback; if it doesn't, the PR is incomplete.
- **GitHub / gh-ost** — online schema changes, never lock production tables. Apply: credential store schema changes are additive-first; never a destructive single-step migration.
- **DHH / Basecamp** — every commit on main is shippable; no WIP on main. Apply: a half-finished `@sym/contracts` change can't sit on main; either complete it or land behind a feature gate.
- **Google / protobuf** — types reviewed as their own artifact. Apply: contract changes get their own PR conversation; implementation follows.
- **Anthropic / model versioning** — pin models, change versions explicitly. Apply: `FIREWORKS_MODEL` is an explicit env var; model upgrades are conscious operator decisions, not silent drift.

---

## Output

Every PR that touches `@sym/contracts`, the credential store schema, the config
file format, or any cross-package interface includes this section in its
description:

```md
## Cross-unit impact

- Units changed: [list]
- Units consuming: [list]
- Backward compatible: [yes / expand-contract / breaking]
- Expand-contract plan: [N/A or 3 phases]
- Deploy / volume impact: [safe redeploy / credential store migration / config version bump]
- Rollback plan: [revert / two-step / etc.]
- Observability added: [log lines / sym status fields / N/A]
- Eval impact: [N/A / prompt.ts updated / integration test added]
```

If any line is "N/A," explain why.

---

## When to skip this skill

- Pure refactors within one package that don't change exports
- Comments, README, internal helper functions
- Test-only changes

Everything else: run the checklist.

---

## Improvement loop

This skill is v1. As we hit failure modes — a missed consumer, a botched rollback, a deploy ordering bug — capture the lesson here. The checklist gets sharper with every near-miss.
