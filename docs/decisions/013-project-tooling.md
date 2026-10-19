# 013. Project tooling

Status: accepted
Date: 2026-10-19

## Context

Sym is a TypeScript Eve app. It needs fast local checks and a CI gate that works for a private
repository now and a public one later.

## Decision

Node 24 and pnpm, pinned in `mise.toml`. Eve is pinned to an exact version. Biome lints and
formats, `tsc` typechecks, Vitest tests, and Knip finds unused files, exports, and dependencies.
CI is a self-contained workflow with actions pinned to full commit SHAs, plus zizmor on the
workflows. CI runs `eve build --skip-sandbox-prewarm`, because Sym sets `defaultTools: false` and
the full build pulls Eve's sandbox image.

## Consequences

CI does not depend on a private shared workflow, so it keeps working when the repository becomes
public. Deploy images must run the full `eve build`.
