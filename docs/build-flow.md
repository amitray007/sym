# Sym Build Flow

## Metadata

- Created: 2026-05-23
- Last Edited: 2026-05-23
- Status: **Active · visual companion to the build plan**
- Owner: Sym authors

## Changelog

- 2026-05-23: Initial diagram. Spine → early forks → M1 → late forks →
  M2 → M3, with hidden cross-stream wiring rendered as dotted edges.

---

## Intent

A single diagram you can look at to know what to build next and what
can be built in parallel. Pairs with `implementation-ideology-plan.md`
(detailed flow) and `db-schema-draft.md` (the spine's most-loaded chunk).

---

## The Diagram

```mermaid
flowchart TB
    %% ================== SPINE ==================
    subgraph SPINE ["🦴 SPINE — sequential, must finish first"]
      direction TB
      Sp1["Sp1 · Monorepo + tooling<br/>pnpm · turbo · tsconfig · PR template"]
      Sp2["Sp2 · @sym/db schema<br/>Postgres · Drizzle · migrations"]
      Sp3["Sp3 · @sym/contracts<br/>branded IDs · Turn · Reply · interfaces"]
      Sp4["Sp4 · @sym/secrets<br/>libsodium · encryptedText"]
      Sp1 --> Sp2
      Sp1 --> Sp3
      Sp2 --> Sp4
      Sp3 --> Sp4
    end

    %% ================== EARLY FORKS ==================
    subgraph EARLY ["⚡ EARLY FORKS — start when spine lands"]
      direction LR
      S1["S1 · Slack adapter<br/>install · ingress · outbound · Block Kit"]
      S2["S2 · Kernel + Fireworks<br/>thin loop · provider · receipt"]
      S3["S3 · Dashboard shell<br/>Next.js · Clerk · allowlist gate"]
      S6["S6 · Sandbox + egress<br/>Docker · gVisor · proxy · leases<br/>🔴 LONG POLE — start day 5"]
      S8["S8 · DevEx · CI · Deploy<br/>GH Actions · Dokploy · smoke"]
    end
    Sp4 --> S1
    Sp4 --> S2
    Sp4 --> S3
    Sp4 --> S6
    Sp4 --> S8

    S4["S4 · First-time settings wizard<br/>provider config · ACL · Slack install"]
    S3 --> S4
    Sp2 --> S4

    %% ================== MILESTONE 1 ==================
    M1{{"🎯 M1 — install → @-mention → Fireworks reply"}}
    S1 --> M1
    S2 --> M1
    S4 --> M1

    %% ================== LATE FORKS ==================
    subgraph LATE ["🔄 LATE FORKS — after M1 proves the skeleton"]
      direction LR
      S5["S5 · MCP + skills<br/>HTTP/stdio · tool registry · skill loader"]
      S7a["S7a · Memory<br/>retrieval gate · change policy · evals"]
      S7b["S7b · Audit + receipts<br/>hash chain · OTel · SSE broadcast"]
      S7c["S7c · Tasks<br/>durable queue · slice/checkpoint"]
      S7d["S7d · Soul + tone<br/>cascade · rewriter · substance-diff guard"]
    end
    M1 --> S5
    M1 --> S7a
    M1 --> S7b
    M1 --> S7c
    M1 --> S7d

    %% Hidden cross-stream wires
    S6 -. "tool dispatch via sandbox" .-> S5
    S2 -. "retrieval call" .-> S7a
    S2 -. "slice/checkpoint hook" .-> S7c
    S2 -. "tone-rewrite hook" .-> S7d
    S1 -. "audit on every Slack write" .-> S7b
    S2 -. "audit on every completion" .-> S7b

    %% ================== MILESTONE 2 ==================
    M2{{"🎯 M2 — tool call end-to-end with audit + receipt"}}
    S5 --> M2
    S6 --> M2
    S7b --> M2

    %% ================== MILESTONE 3 ==================
    M3{{"🎯 M3 — memory + soul + grants observable in Slack"}}
    M2 --> M3
    S7a --> M3
    S7d --> M3

    %% Styling
    classDef milestone fill:#dc2626,stroke:#7f1d1d,color:#fff,font-weight:bold
    classDef longpole fill:#ea580c,stroke:#7c2d12,color:#fff
    classDef spine fill:#1e3a8a,stroke:#1e40af,color:#fff
    classDef early fill:#065f46,stroke:#047857,color:#fff
    classDef late fill:#5b21b6,stroke:#6d28d9,color:#fff
    class M1,M2,M3 milestone
    class S6 longpole
    class Sp1,Sp2,Sp3,Sp4 spine
    class S1,S2,S3,S4,S8 early
    class S5,S7a,S7b,S7c,S7d late
```

---

## How to Read It

- **Vertical = dependency order.** Anything below depends on something
  above. You can't start a node until its solid-arrow predecessors are
  done.
- **Subgraph boxes = parallelism zones.** Everything inside a subgraph
  can be built in parallel by different owners.
- **Dotted arrows = wiring contracts.** The two endpoints don't block
  each other to start, but they share an interface — lock that interface
  in `@sym/contracts` before either side writes code.
- **🎯 milestones are "system is alive" checkpoints.** Don't move past
  one until it actually works end-to-end in Slack.
- **🔴 S6 (sandbox) is the long pole.** Start it the day spine lands
  even though it's not needed until M2 — by the time you "need" it,
  you'd be blocked.

---

## Legend

| Color | Meaning |
|---|---|
| 🟦 Blue (spine) | Sequential foundation; everything depends on these |
| 🟩 Green (early) | Forks the day spine lands; parallel work |
| 🟧 Orange (long pole) | Start early, takes longest, hide behind interfaces |
| 🟪 Purple (late) | Forks after M1 proves the skeleton; parallel work |
| 🟥 Red (milestone) | Observable end-to-end checkpoint; don't move past until live |

---

## What the diagram doesn't show (and why)

- **Calendar.** Nodes ship when they ship; the diagram is dependency
  order, not time. We don't do phases.
- **The cross-unit-impact discipline.** It governs every PR — depicting
  it as edges would clutter the diagram. See
  `.claude/skills/cross-unit-impact/SKILL.md`.
- **Stream internals.** Each Sx node hides 5-10 internal pieces. Those
  are listed in `implementation-ideology-plan.md` under that stream's
  section.
- **Runtime data flow.** This is build order, not request order. A
  runtime diagram (Slack event → Kernel → Tool → Sandbox → Reply →
  Slack) would be a separate document if needed.

---

## Related

- `docs/implementation-ideology-plan.md` — the prose flow this diagram
  visualizes; per-stream internals live there
- `docs/db-schema-draft.md` — the Sp2 review artifact
- `docs/files-to-care-about.md` — blast-radius map of files
- `docs/specs/sym-overview-spec.md` — product + architecture decisions
- `.claude/skills/cross-unit-impact/SKILL.md` — discipline applied on every PR
