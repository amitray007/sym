---
name: cross-unit-impact
description: Use whenever changing a database schema, contract type, shared interface, or any package consumed by multiple streams in Sym. Forces you to think through how every other unit reacts to the change, with production-grade migration discipline drawn from how Stripe, Shopify, Linear, Honeycomb, GitHub, and DHH-style Rails shops manage live systems. Run BEFORE writing the change and again before opening the PR.
---

# Cross-Unit Impact Discipline

**Core principle:** every change is a multi-unit change. The unit you're editing is never the only unit affected. Before touching code, name every other unit that reacts to this change, and design the change so all of them remain working at every intermediate state — including a half-deployed state, and a rolled-back state.

This skill exists because Sym is config-as-database with two services sharing one Postgres. The Dashboard writer and the Agent reader can be at different versions during deploy. Schema changes that look local are global. Type changes that look local are global. Migration discipline is not optional.

---

## The checklist — run BEFORE editing

For the change you're about to make, answer these in order. If you can't answer cleanly, stop and redesign.

### 1. What units consume this?

List every package, service, deploy target, or external integration that reads or writes the thing you're changing. Be specific. "Everyone" means you haven't thought about it.

- Schema change → list every Drizzle query that hits this table
- Contract change → list every package that imports the type
- API change → list every caller
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

Sym is two services sharing one DB. Order matters. State it explicitly:

- DB migration → which service deploys first?
- Does the order assume the migration ran? What if it didn't?
- Can the Dashboard ship before the Agent? Vice versa?

If the answer is "doesn't matter, fully compatible," good — write that down in the PR.

### 5. What's the rollback plan?

For every change, the rollback story must exist. Write it in the PR:

- "Revert PR + redeploy" is a valid rollback only if the schema change is reversible. Most aren't.
- For schema migrations: rollback usually means leaving the new shape in place but reverting the code. Plan for that.
- For data backfills: are they idempotent? Can they be re-run?
- For type-only changes in `@sym/contracts`: rollback is the inverse PR; track all consumers.

Honeycomb's rule: "if you can't rollback, you can't deploy."

### 6. What audit + observability does this need?

If the change introduces new behavior:

- Audit event with the right semantic key? (See `specs/logging/`)
- OTel span/event with `gen_ai.*` / `app.*` keys?
- Metric to detect when the change is misbehaving in production?

Adding observability after the fact is 10× the work. Bake it into the same PR.

### 7. What eval changes?

For changes touching memory, soul, prompt assembly, retrieval, or anything model-behavior-shaped:

- promptfoo eval set updated?
- Thresholds tightened or loosened? Document why.
- Did the change pass eval at the existing threshold?

### 8. What's the contract surface?

If your change touches `@sym/contracts`:

- All consuming packages updated in the same PR, OR
- Field added as optional, old usage tagged `@deprecated`, removed in a later PR
- No "we'll fix consumers in a follow-up." That's two PRs masquerading as one.

---

## Schema change subroutine

Database schema is the highest-blast-radius change in Sym. Run this every time:

1. **Additive only by default.** New tables, new nullable columns, new indexes — generally safe.
2. **`NOT NULL` only after backfill.** Never add `NOT NULL` in the same migration that adds the column. Two migrations: add nullable + backfill → add `NOT NULL`.
3. **Drops are two-phase.** First migration: stop writing. Deploy. Verify. Second migration: drop.
4. **Renames are three-phase.** Add new column → dual-write → switch readers → drop old. Same for renamed tables.
5. **Indexes use `CONCURRENTLY`** in Postgres. No locking migrations during business hours.
6. **Enums grow only.** Adding a value is safe. Removing a value is a multi-phase migration (stop writing → wait → drop).
7. **Migration file is reviewed independently of code.** Schema review is its own discipline.
8. **Drizzle types regenerated and committed in the same PR as the migration.**

Reference: gh-ost, pt-online-schema-change, Vitess online DDL, Square Sake all encode these rules in tools. Sym does it by discipline because we're small.

---

## What top developers do, condensed

- **Stripe** — date-based API versions, server-side translation, never silent break. Apply: when our contracts evolve, mark old shapes deprecated with a removal date, don't surprise consumers.
- **Shopify** — every deploy backward + forward compatible for at least one prior deploy. Apply: rollback to yesterday's binary must keep working with today's schema.
- **Linear / cross-repo coordination** — bot opens PRs in every consumer; nothing merges until all green. Apply: when changing `@sym/contracts`, the same PR touches every consumer package — turbo's affected graph is your friend.
- **Honeycomb / deploy ordering** — explicit, documented, rehearsed. Apply: PR description lists deploy order and rollback steps; if it doesn't, the PR is incomplete.
- **GitHub / gh-ost** — online schema changes, never lock production tables. Apply: every Sym migration is written with the assumption that production reads/writes continue throughout.
- **DHH / Basecamp** — every commit on main is shippable; no WIP on main. Apply: a half-finished `@sym/contracts` change can't sit on main; either complete it or land behind a feature gate.
- **Google / protobuf** — types reviewed as their own artifact. Apply: contract changes get their own PR conversation; implementation follows.
- **Anthropic / model versioning** — pin models, change versions explicitly. Apply: provider config in Sym pins model versions; upgrades are conscious dashboard actions, not silent.

---

## Output

Every PR that touches schema, `@sym/contracts`, or any cross-stream interface includes this section in its description:

```md
## Cross-unit impact

- Units changed: [list]
- Units consuming: [list]
- Backward compatible: [yes / expand-contract / breaking]
- Expand-contract plan: [N/A or 3 phases]
- Deploy order: [doesn't matter / DB → Dashboard → Agent / etc.]
- Rollback plan: [revert / two-step / etc.]
- Audit + OTel added: [list of events]
- Eval impact: [N/A / set updated / thresholds]
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
