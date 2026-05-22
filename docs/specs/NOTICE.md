# Provenance

The contents of this `docs/specs/` directory were initially copied from
**[getsentry/junior](https://github.com/getsentry/junior)** at the time of
this commit, and are being adapted to describe Sym's technical contracts.

- Original work © Sentry contributors, licensed under **Apache License 2.0**.
- The full original license text is preserved here as
  [`LICENSE-junior.txt`](./LICENSE-junior.txt).

All subsequent modifications, additions, and removals are by the Sym authors
and are **also released under Apache License 2.0** unless otherwise noted.

## Why we did this

We are not forking Junior. We are not tracking Junior upstream. We copied
the specs once, as reference contracts that describe well-thought-out
solutions to problems we also have (plugin manifests, slice/checkpoint
resumability, sandbox egress, OAuth flows, Slack delivery, telemetry
semantics). We will tweak each one where Sym's design intentionally
diverges.

## What changes when we tweak a spec

When a spec is materially modified, the file's frontmatter or top notes
should reflect:

- the original Junior spec it descends from (if non-obvious),
- a short "Sym deltas" section listing where we diverge from upstream
  and why.

## Spec files in this tree

See [`index.md`](./index.md) for the upstream Junior taxonomy. Sym's own
spec index will live alongside it as we begin adapting individual files.
