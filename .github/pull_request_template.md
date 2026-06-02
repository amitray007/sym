<!--
  Cross-unit impact is mandatory from PR #1.
  See .claude/skills/cross-unit-impact/SKILL.md for the full discipline.
  If a section is "N/A", state why — don't delete the section.
-->

## Summary

<!-- 1–3 sentences. What is this PR and why does it exist? -->

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
- **Deploy order:** <!-- doesn't matter (why) OR N/A (why) -->
- **Rollback plan:** <!-- revert PR / two-step / N/A (why) -->
- **Eval impact:** <!-- N/A (why) / set updated / thresholds changed -->

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

<!-- Build-plan chunks, prior PRs, issues. -->

-
