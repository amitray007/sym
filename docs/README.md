# Sym — design docs

Working codename: **Sym** (short for *symbiosis* — a teammate that lives where the team lives).

This folder is the living design record for an AI workspace teammate. It is
opinionated, iterative, and written to be read in order. Each document is
self-contained but assumes the vision in `00-vision.md`.

## How to read this folder

1. Start with `00-vision.md`. That's the north star.
2. Skim `01-positioning.md` for what we are *not* doing — useful to ground
   the rest.
3. Read `02-architecture.md` for the system shape.
4. The deep-dive docs (`03–09`) can be read in any order; each one assumes
   the architecture sketch.
5. `10-v1-scope.md` is the actual MVP cut. If you're shipping, read this
   before writing code.

## Index

| # | File | What's inside |
|---|------|---------------|
| 00 | [`00-vision.md`](./00-vision.md) | Product vision, north star, the "teammate not a bot" thesis |
| 01 | [`01-positioning.md`](./01-positioning.md) | Differentiation vs pookie, Hermes-style internal bots, Glean, Dust, Slack AI |
| 02 | [`02-architecture.md`](./02-architecture.md) | High-level system: adapters → routing → runtime → tools → state |
| 03 | [`03-memory-model.md`](./03-memory-model.md) | Scoped memory: personal / project / team, partition rules, retention |
| 04 | [`04-skills-and-mcp.md`](./04-skills-and-mcp.md) | Skill + MCP registry, governance, versioning, scope inheritance |
| 05 | [`05-tasks-async.md`](./05-tasks-async.md) | Long-running, resumable tasks; supervisors; status surfacing |
| 06 | [`06-tone-and-formality.md`](./06-tone-and-formality.md) | Work-awareness layer: per-channel tone calibration |
| 07 | [`07-permissions-privacy.md`](./07-permissions-privacy.md) | Platform-derived auth, scope leak prevention, redaction |
| 08 | [`08-platform-adapters.md`](./08-platform-adapters.md) | Slack / Teams / Discord adapter abstraction |
| 09 | [`09-observability.md`](./09-observability.md) | Audit, explainability, "why did you do that?" |
| 10 | [`10-v1-scope.md`](./10-v1-scope.md) | MVP — what's in, what's out, success criteria |
| 11 | [`11-competitive-landscape.md`](./11-competitive-landscape.md) | Detailed comparison of nearby products |
| 12 | [`12-risks-mitigations.md`](./12-risks-mitigations.md) | What could go wrong + how we'd respond |
| 13 | [`13-data-model.md`](./13-data-model.md) | Schemas, key namespaces, encryption boundaries |
| 14 | [`14-roadmap.md`](./14-roadmap.md) | Phased rollout from MVP to platform |

## Working principles for this folder

- **Decisions over discussion.** Every doc ends with explicit decisions
  and explicit open questions. No "we should consider..." prose dangling
  in the middle.
- **Cite the reference.** Where a design borrows from pookie, Hermes, or
  another system, name it and link the relevant file/line if available.
- **Reversibility matters.** Flag which decisions are easy to change
  later (e.g., default tone) and which are foundational (e.g., scope
  partition keys baked into storage).
- **No premature abstraction.** v1 ships Slack-only; the adapter
  abstraction exists so we don't paint ourselves into a corner, not so
  we can spin up Discord in week one.

## How this differs from pookie at a glance

Pookie is a great single-workspace Slack bot with shared personality,
scoped memory, MCP integrations, and a cron tool. Sym takes that
foundation seriously and pushes on five things pookie doesn't try to
solve:

1. **Multi-platform from the architecture out** — Slack first, but the
   adapter boundary is sharp enough to ship Teams / Discord without a
   rewrite.
2. **Per-channel tone calibration** — pookie picks one of three
   personalities per workspace. Sym calibrates per channel, per
   audience, per message, with the workspace setting as a floor.
3. **Durable resumable tasks, not just cron** — pookie schedules
   prompts; Sym owns multi-step background work with status, cancel,
   audit, and recovery.
4. **Skills as governed, versioned artifacts** — pookie exposes MCPs
   via slash commands with scope flags. Sym treats each skill as a
   reviewable package with a manifest, version pin, and team-level
   approval flow.
5. **End-to-end privacy receipts** — pookie partitions memory by
   user/channel/team and trusts the model not to leak across scopes.
   Sym enforces partitions at the retrieval layer and emits a receipt
   (what was recalled, from where, why) attached to each response.

Detail on each of these lives in the relevant doc.
