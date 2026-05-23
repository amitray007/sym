<!--
  Cross-unit impact is mandatory from PR #1.
  See .claude/skills/cross-unit-impact/SKILL.md for the full discipline.
  If a section is "N/A", state why — don't delete the section.
-->

## Summary

<!-- 1–3 sentences. What is this PR and why does it exist? -->

## Stream

<!-- Which build-plan stream owns this change? e.g. Sp1, Sp2, S1, S7a, S8 -->

Stream:
End goal touched:

## What changed

<!-- Bullet list of the substantive changes. Group by package/app. -->

-

## Cross-unit impact

<!--
  Run the cross-unit-impact skill BEFORE writing this section.
  Every line must be filled. "N/A" requires a one-line justification.
-->

- **Units changed:**
- **Units consuming:**
- **Backward compatible:** <!-- yes / expand-contract / breaking -->
- **Expand-contract plan:** <!-- N/A (why) OR three phases listed -->
- **Deploy order:** <!-- doesn't matter (why) OR e.g. DB migration → Dashboard → Agent -->
- **Rollback plan:** <!-- revert PR / two-step / N/A (why) -->
- **Audit + OTel added:** <!-- list event names + semantic keys, or N/A (why) -->
- **Eval impact:** <!-- N/A (why) / set updated / thresholds changed -->

## Schema / migration notes

<!-- Only required if this PR touches packages/db/. Otherwise delete this section. -->

- Additive only?
- `NOT NULL` after backfill?
- Drops two-phase? Renames three-phase?
- Indexes `CONCURRENTLY`?
- Drizzle types regenerated and committed?

## Contracts notes

<!-- Only required if this PR touches packages/contracts/. Otherwise delete this section. -->

- Consumers updated in this PR? Or `@deprecated` with removal date?
- Branded IDs preserved?

## Verification

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Manual verification (describe):

## Related

<!-- Spec sections, build-plan chunks, prior PRs, issues. -->

-
