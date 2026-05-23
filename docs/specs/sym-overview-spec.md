# Sym Overview Spec

## Metadata

- Created: 2026-05-23
- Last Edited: 2026-05-23
- Status: **Draft · v0.2 · pre-implementation**
- Owner: Sym authors

## Changelog

- 2026-05-23 (v0.1): Initial draft. Captures the consolidated ideation
  decisions. Derives reference contracts from
  [getsentry/junior](https://github.com/getsentry/junior) copied into
  this directory with explicit Sym deltas.
- 2026-05-23 (v0.2): Lock-in revision. Sym is built **from scratch**
  (no Junior fork). Adopts dashboard-first config-as-database
  architecture, two-server topology (Dashboard + Agent), MIT license,
  Postgres + Redis native, indefinite retention with change-policy
  memory, Next.js + Tailwind + shadcn for the Dashboard, Hono for the
  Agent, promptfoo for evals, deferred observability backend, Dokploy
  + GitHub Actions for CI/CD.

## Status

Active design record. This spec is the canonical entry point for the
detailed Sym contracts. It enumerates what Sym is, what it ships in v1,
and where its contracts diverge from the upstream Junior specs that
are preserved alongside it as reference material.

Junior's specs in this directory are **reference contracts** —
patterns we study and adapt — not source code to fork. Each Tier 1
spec is read by the engineer implementing that subsystem and adapted
into our own code with our own choices.

## Purpose

Define, in one document:

- The product thesis of Sym
- The hard product + architectural decisions for v1
- The two-server topology and dashboard-first config model
- The Sym-specific deltas against each adapted Junior spec
- The phased build plan and "what we own" boundary

## Scope

- v1 product surface and constraints
- Runtime architecture at the package/module level
- Memory model (with change policy), soul cascade, plugin model, trust
  boundary
- Provider, sandbox, storage, dashboard, eval choices
- Build sequence and ownership boundaries

## Non-Goals

- Defining individual tool schemas or prompt prose. Those belong in
  per-subject specs and the runtime code respectively.
- Defining detailed Slack API contracts. The adapted
  `slack-agent-delivery-spec` and `slack-outbound-contract-spec` own
  those, with Sym deltas noted in this overview.
- Defining specific eval criteria. Those live with the eval harness.

## Product Thesis

Sym is an AI teammate that lives in a single team's Slack workspace,
configured and observed through its own dashboard. **Not a bot, not a
search tool — a teammate.** Joins channels, holds opinions, remembers
what matters, owns tasks, is accountable for everything it does.

Trust is a system property: scope discipline, provenance, auditability,
reversibility. Where trust and capability conflict, trust wins.

The "teammate test" is the cheapest correctness rubric: *would a
thoughtful new hire do this?* If no, Sym doesn't either.

## v1 Hard Decisions

The following are **hard architectural commitments** for v1. Reversing
any of them is a v2-class change.

### License + distribution

- **MIT license.**
- Private OSS / internal use. Not published to public npm; consumed
  via `@sym/*` workspace scope inside the monorepo only.
- Single repo, single org, public-style hygiene.

### Tenancy

- **One Sym install = one Slack workspace.** Single-tenant by design.
- Multi-workspace orchestration is a v2 concern, not a code concern
  in v1.

### Topology (Two servers)

Two separately deployable services, one shared store:

| Service | Role | Stack |
| --- | --- | --- |
| **Dashboard** (`apps/dashboard`) | Control plane: install flow, ACL, config, MCP installs, audit, lightweight reporting | Next.js + Tailwind + shadcn + TypeScript |
| **Agent** (`apps/agent`) | Slack-side runtime: ingress, agent loop, sandbox, delivery | Hono + custom thin loop |
| Shared | Both deployables read/write the same Postgres + Redis | — |

The Dashboard is the source of truth. The Agent is a stateless
config-consumer that reads from Postgres on every turn.

### Surface (Slack only)

- **Slack only.** No adapter abstraction, no Teams, no Discord — ever.
- The Slack adapter is **Slack-deep**: Block Kit, modals, App Home,
  slash commands, message shortcuts, reactions, canvases, Lists.

### Deployment

- **No Vercel coupling.** We ship our own infra:
  - Web framework: Hono (Agent) + Next.js (Dashboard)
  - Sandbox: Docker + gVisor
  - Egress proxy: our own Hono service with JWT identity from sandbox
  - Postgres: **local, native install** (not Docker)
  - Redis: **local, native install** (not Docker)
- Hosting target: **Dokploy VPS** with portable Docker setup so
  it can run anywhere
- CI: **GitHub Actions** + Dokploy built-in build pipelines

### Provider

- **Default: Fireworks**, accessed via its OpenAI-compatible interface.
- Default model is **tweakable via Dashboard** — pick initial set
  during phase 02, configure per task class (chat, tone-rewrite,
  summarization) as needs become clear.
- Provider interface lives inside `@sym/kernel`; second provider
  extracts it later.
- Future providers (OpenAI, Anthropic, Cerebras, custom OpenAI-compat
  URLs) implement the same interface and live in their own packages
  when they ship in v1.x+.

### Agent Loop

- **Custom thin agent loop** (~500 lines) directly on the provider SDK.
- No Pi, no Vercel AI SDK, no LangChain.
- Slice/checkpoint is our primitive — adapted in shape from Junior's
  contract but implemented entirely in our code.

### Storage

| Workload | Store | Native? |
| --- | --- | --- |
| Config (providers, MCPs, skills, soul, ACL, grants) | Postgres | yes |
| Memory (5 scopes + change policy) | Postgres | yes |
| Tasks (durable queue + checkpoints) | Postgres | yes |
| Audit log + receipts | Postgres | yes |
| Conversation transcript | Postgres | yes |
| OAuth tokens + encrypted secrets | Postgres + libsodium | yes |
| Vector recall (added in v1.x) | pgvector on Postgres | yes |
| Per-thread locks | Redis | yes |
| Rate-limit buckets | Redis | yes |
| OAuth state TTL (10-min) | Redis | yes |
| MCP auth session state | Redis | yes |

- ORM: **Drizzle**. TS-first, type-safe queries, lightweight migrations.
- Secrets at rest: **Postgres + libsodium** (application-layer encryption,
  key in env, ciphertext in DB).

### Retention

- **Indefinite by default** for both chat history and memory.
- The interesting question isn't "when do we forget?" but "when do
  we change what we know?" — answered by the change policy below.
- Admin can override retention per scope via Dashboard (e.g. set
  channel retention to 90 days).

### Telemetry / Observability

- **Lightweight in-Dashboard reporting** in v1: latency, cost,
  message volume, tool-call failure rate, memory write count.
- OpenTelemetry SDK is wired throughout the code with semantic keys
  (`gen_ai.*`, `app.credential.*`, `app.memory.*`, `app.soul.*`,
  `messaging.*`), but **no external observability backend** ships in
  v1. SDK exporter can be configured at any time later (SigNoz,
  Grafana, Honeycomb, etc.).

### Eval Harness

- **promptfoo.** YAML configs, self-hostable, CI-integratable.
- Eval sets live alongside packages they cover (memory change policy
  eval lives next to `@sym/memory`, tone-rewrite eval lives next to
  `@sym/kernel/tone`).

### Slack App

- Single workspace handles **both dev and production**.
- Install via the Dashboard's OAuth redirect flow only. There is no
  marketplace listing in v1.
- Dashboard access is **required** for anyone interacting with Sym —
  no Slack-only configuration.

## Memory Model

### Five scopes

Sym persists memory in five scopes. Each is enforced at the **retrieval
layer**, not in the prompt — the model only ever sees what the
requester is allowed to recall.

| # | Scope | Visible to | Typical use |
| --- | --- | --- | --- |
| 1 | **Workspace** | all workspace members | Org glossary, ownership map, "how we do things here" |
| 2 | **Channel** | channel members only | Channel norms, active topics, decisions made here |
| 3 | **Thread** | thread participants only | Tight transient context for one thread |
| 4 | **DM** | one user only | Per-user prefs, tone, name pronunciation |
| 5 | **Custom relational** | grantor + subject | Facts User A told Sym *about* User B with explicit consent |

The **custom relational** scope is keyed on `(actor_id, subject_id)`
and has its own consent rules (subject must accept or the memory is
not retrievable when subject queries).

### Change policy (replaces "formation policy")

Memory retention is indefinite. The model that matters is what
*changes* in memory when new information arrives. The change policy
is a four-state classifier evaluated against an eval set:

| State | Condition | Effect |
| --- | --- | --- |
| **add** | New fact is independent of existing memories | Insert new memory row |
| **update** | New fact refines existing memory without contradicting it | Update content, sharpen wording, audit trail preserved |
| **supersede** | New fact contradicts an existing memory | Old marked `superseded`, new becomes authoritative |
| **ignore** | Casual chitchat, jokes, single passing mentions, Sym's own output, failed tool calls | Nothing written |

Substantive signals that lift a candidate above `ignore`:
- Explicit "remember this" / "from now on" / "always" / "never"
- Repeated mention (≥2× across turns by default — tunable per scope)
- Preference statements: "I prefer X / always X / never X"
- Tool-call habit: same flow run ≥3 times by the same user

The policy is encoded as `classify_memory_change(turn, candidate,
existing_memories) → {add | update | supersede | ignore}` and evaluated
against a promptfoo eval set kept alongside `@sym/memory`. Initial
thresholds are starting points and are tunable per workspace via
Dashboard.

### Retrieval gate

Every recall passes a gate taking `(requester, scope_filter,
permissions)` and returning only entries the requester is allowed to
see. The gate runs in `@sym/memory`, not in the agent prompt. CI
red-team test suite verifies no cross-scope leakage.

## Soul Cascade

Sym's voice is layered across `.soul.md`-equivalent rows in Postgres,
cascading CSS-style. More-specific layers override less-specific.
Applied by the runtime as a **tone-rewrite stage** after the agent
produces draft text.

| Layer | Identifier | Scope |
| --- | --- | --- |
| L0 | `sym.soul.md` (built-in) | Global teammate posture — hedge, confirm destructive, never confabulate |
| L1 | `workspace.soul.md` | Workspace tone floor (casual / neutral / formal) |
| L2 | `channel/<id>.soul.md` | Per-channel override |
| L3 | `user/<id>.soul.md` | Per-user preference |

A **substance-diff guard** runs before the rewritten output is
delivered: if the rewrite changes factual content (vs. just tone),
it is rejected and the original text is delivered.

**Live-reload:** soul rows live in Postgres and are edited through
the Dashboard. The runtime caches per-conversation but invalidates
on write timestamp — the next turn sees the new cascade. No file
watching, no restart required.

Memory and soul are strictly separated stores. Memory is *facts*; soul
is *voice*.

## Plugin Model · MCP-first + CLI-fallback

Extensions to Sym arrive in three shapes:

1. **MCP servers** — declarative rows in the `mcp_configs` Postgres
   table, edited via Dashboard. No code. First-class for any provider
   with an MCP server.
2. **CLI-fallback plugins** — for providers without MCP. `plugin.yaml`
   shape (from Junior) with `runtime-dependencies` installed inside
   the sandbox. Sandbox snapshots cache the installed CLIs.
3. **Skills** — rows in the `skills` Postgres table, content stored as
   markdown with YAML frontmatter, edited via Dashboard. Workflow
   guidance — *how* to do a domain task. Loaded on demand by the
   agent. Never holds secrets.

All three are configured through the Dashboard (no yaml files in v1).

### Per-user OAuth + Cross-user grants

Each user OAuths their own provider accounts. Sym stores tokens by
`(user_id, provider)`. When User A asks Sym to do GitHub work, Sym
uses User A's token.

Cross-user grants follow this UX:

1. User A opens **Dashboard → Integrations → Share** and selects the
   grantee (User B), the scope, and the TTL.
2. Dashboard writes a `grants` row.
3. Sym posts a **Slack text confirmation** to User B (ephemeral DM)
   acknowledging the grant was issued.
4. When User B asks Sym to do GitHub work and has no direct token,
   Sym checks for an active grant and uses it (scope-restricted).
5. Every cross-user call is audited with `actor + on_behalf_of`.

Grant rules:

- Time-boxed (default 24h, max 7d)
- Scope-restricted (cannot exceed grantor's OAuth scope)
- Revocable by grantor at any time via Dashboard
- Non-transitive (User B cannot re-grant)

## Trust Boundary · Sandbox + Egress

Tools run inside a per-turn **Docker + gVisor sandbox**:

- Ephemeral (destroyed at end of turn)
- Isolated network namespace
- All outbound traffic routes through Sym's egress proxy

The **egress proxy**:

- Verifies sandbox identity (short-lived JWT minted at spawn)
- Looks up the credential lease for `(requester, provider, domain)`
- Injects auth headers at request time
- Strips hop-by-hop + proxy-control headers
- Logs every outbound call to `@sym/audit`

The model never sees tokens. The sandbox filesystem never holds tokens.
Tokens live only in the proxy's lease store (in-memory + Postgres
encrypted backup), valid only for the active turn.

## Access Control

Sym ships an ACL gating Slack interaction and Dashboard access
separately:

| Mode | Slack interaction | Dashboard access |
| --- | --- | --- |
| `open` | Anyone in workspace | Configured admins |
| `allowlist` | Only listed users | Listed admins |
| `workspace_minus_blocked` | Workspace minus blocked | Listed admins |

Stored as `acl_rules(workspace_id, user_id, surface, status)`.
Dashboard access is always narrower than or equal to Slack access by
policy.

Bootstrap: the user who completes the initial Slack OAuth install via
Dashboard becomes the first admin. Additional admins are added by
existing admins from the Dashboard.

## Proactivity Policy

Sym **does not speak unprompted** in v1. Allowed triggers:

| Trigger | When |
| --- | --- |
| Direct `@-mention` | Anywhere Sym is invited |
| DM | Without `@-mention` |
| Task-fired output | A registered task fires (e.g., `pr-watcher`, `digest`) |

Future tiers (v1.x+) add "watcher actions earn authority to speak,"
gated by the Dashboard.

## Surfaces

### Control plane · Sym Dashboard

The Dashboard (Next.js + Tailwind + shadcn + TypeScript) is the
admin surface. Without the Dashboard, Sym has nothing to do.

v1 capabilities:

- **Slack install** (OAuth landing, first-admin bootstrap)
- **ACL editor** (allowed users, Dashboard admins)
- **Provider config** (Fireworks key, model selection per task class)
- **MCP installs** (add server, OAuth setup, tool browse)
- **Skills editor** (SKILL CRUD with preview)
- **Soul cascade editor** (L1–L3 with live cascade preview)
- **Cross-user grants** (issue, view, revoke)
- **Memory viewer** (per-scope browse, supersede, forget)
- **Audit + activity feed** (live SSE, exportable, hash-chained)
- **Lightweight reporting** (latency, cost, message volume, failure rate)

v1.x adds: SSO/SAML for Dashboard access, optional OTel exporter
configuration (SigNoz, Grafana, etc.), advanced filter/search.

### Runtime · Slack (rich-native)

The Agent (Hono + custom thin loop) uses every relevant Slack API
surface:

- Block Kit Builder layouts
- Modals (`views.open`) for confirmations
- App Home tab (quick status + Dashboard deep-link)
- Slash commands (`/sym connect`, `/sym share`, `/sym forget`, `/sym status`)
- Message shortcuts ("Send to Sym", "Watch this", "Summarize")
- Reactions (`:eyes:` processing, `:white_check_mark:` done, `:thinking_face:` reasoning)
- Live status (`assistant.threads.setStatus`) with phase labels
- Slack Canvases for long-form output
- Slack Lists for tracked items
- Files API for uploaded artifacts

## Architecture Overview

```
                     admin user                slack workspace
                         │                            │
                         ▼                            ▼
              ┌────────────────────┐      ┌────────────────────┐
              │   sym dashboard    │      │     sym agent      │
              │   (next.js)        │◀────▶│     (hono)         │
              │                    │      │                    │
              │ · slack install    │      │ · ingress          │
              │ · acl editor       │      │ · agent loop       │
              │ · provider config  │      │ · tone rewrite     │
              │ · mcp installs     │      │ · sandbox          │
              │ · skills + soul    │      │ · egress proxy     │
              │ · grants           │      │ · mcp + skill load │
              │ · audit + memory   │      │ · oauth + leases   │
              └─────────┬──────────┘      └─────────┬──────────┘
                        │                            │
                        └────────────┬───────────────┘
                                     ▼
                       ┌──────────────────────────┐
                       │  postgres + redis        │
                       │  (config + state + cache)│
                       └─────────────┬────────────┘
                                     │
                                     ▼
                       ┌──────────────────────────┐
                       │  audit · receipts · sse  │
                       │  (hash-chained, streamed)│
                       └──────────────────────────┘
```

## Package Layout

```
sym/
├── apps/
│   ├── dashboard/                Next.js admin (Tailwind + shadcn + TS)
│   └── agent/                    Hono Slack agent
│
├── packages/
│   ├── kernel/                   @sym/kernel — agent loop + interfaces + tone
│   ├── state/
│   │   ├── db/                   @sym/db — Postgres schema + Drizzle
│   │   ├── memory/               @sym/memory — 5 scopes + change policy
│   │   ├── tasks/                @sym/tasks — durable queue + slice/checkpoint
│   │   └── audit/                @sym/audit — hash chain + receipts
│   ├── runtime/
│   │   └── sandbox/              @sym/sandbox — Docker + gVisor + egress proxy
│   ├── providers/
│   │   └── fireworks/            @sym/provider-fireworks (default)
│   ├── adapters/
│   │   └── slack/                @sym/adapter-slack
│   ├── ext/
│   │   ├── mcp/                  @sym/ext-mcp — MCP client
│   │   ├── skills/               @sym/ext-skills — skill loader from DB
│   │   └── cli-plugin/           @sym/ext-cli-plugin — CLI fallback
│   └── ui/                       @sym/ui — shared shadcn components
│
├── docs/
│   ├── ideation.html
│   └── specs/                    this directory
│
├── .github/workflows/            GitHub Actions CI
├── docker-compose.yml            local dev (alongside native pg/redis)
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Build Sequence

Four phases, ~16 weeks to pilot with 2 engineers.

### Phase 01 · weeks 1–4 · Dashboard + Install (control plane)

- `apps/dashboard` skeleton (Next.js App Router + Tailwind + shadcn)
- `@sym/db` Postgres schema + Drizzle migrations
- Slack OAuth install flow (admin clicks install → Sym arrives in workspace)
- ACL editor (allowed users, Dashboard admins)
- Provider config UI (Fireworks key, model selection)
- Encrypted secrets store in Postgres
- GitHub Actions CI + Dokploy deploy

### Phase 02 · weeks 5–8 · Agent reads dashboard (end-to-end)

- `@sym/kernel` thin agent loop on Fireworks
- `@sym/adapter-slack` ingress + basic Block Kit replies + App Home stub
- `@sym/ext-mcp` MCP client (HTTP + stdio transports)
- `@sym/ext-skills` SKILL loader (from Postgres)
- Per-user OAuth flow with Slack DM delivery
- One real end-to-end: `@-mention` → Fireworks → MCP tool call → reply

### Phase 03 · weeks 9–12 · Trust + state

- `@sym/memory` 5 scopes + retrieval gate + change policy
- `@sym/tasks` Postgres queue + slice/checkpoint contract
- `@sym/sandbox` Docker + gVisor + egress proxy + leases
- `@sym/audit` hash chain + OTel emitters + receipt formatter
- Dashboard views: memory browser, audit, activity feed (SSE)

### Phase 04 · weeks 13–16 · Catalog + polish

- Wire MCP servers: GitHub · Linear · Calendar · Sentry
- Ship skills: `digest`, `pr-watcher`, `summarize`, `onboard`
- Tone-rewrite stage with substance-diff guard
- Cross-user grants: Dashboard flow + Slack confirmation
- promptfoo eval set: memory change policy, tone-rewrite, retrieval

## Deltas Against Junior Specs

Reference contracts adapted from
[getsentry/junior](https://github.com/getsentry/junior) are preserved
in this directory. Sym-specific divergences:

### `chat-architecture-spec`

- **Two-server topology** instead of one: Dashboard (Next.js) + Agent
  (Hono), shared Postgres + Redis
- Single-tenant per install
- One adapter (Slack)
- All durable state in Postgres (no Redis split for transcript/session)
- No Pi session state — custom slice/checkpoint primitive

### `agent-session-resumability-spec`

- Adopt slice/checkpoint shape (`conversation_id` / `session_id` /
  `slice_id` / `checkpoint_version`)
- Drop Pi `replaceMessages` + `continue()` mechanics — our own loop
  uses Fireworks SDK directly
- Same HMAC-signed timeout callbacks
- Same "no auto-resume after visible output" rule

### `agent-prompt-spec`

- Adopt byte-stable system prompt + per-turn context separation
- Drop deployment-stable `SOUL.md` model in favor of **cascading**
  soul layers (L0–L3) stored in Postgres
- Tone-rewrite is a runtime stage, not prompt prose
- Substance-diff guard before delivery

### `skill-capabilities-spec`

- Adopt lease-based credentials + egress proxy pattern
- Drop Vercel Sandbox OIDC; use our own JWT minted by sandbox spawner
- Add cross-user grant model with Dashboard + Slack confirmation UX
- Keep `runtime-dependencies` + `command-env` for CLI-fallback path
- Keep `sandbox-snapshots` for CLI-heavy plugins

### `plugin-spec`

- MCP-first: most extensions are rows in `mcp_configs` (Dashboard-edited)
- CLI-fallback retains `plugin.yaml` shape for installable CLIs
- Drop `${NAME}` expansion mini-language — env passed by runtime
- Skills are rows in `skills` table with markdown content + frontmatter
- All configuration through the Dashboard (no yaml files in v1)

### `security-policy`

- Adopt every principle (least privilege, short-lived creds, isolation)
- Replace Vercel-specific egress paths with our Docker + gVisor + JWT
- Secrets at rest: Postgres + libsodium (application-layer encryption)
- Add cross-user grant audit rule: every cross-user call must log
  `actor` + `on_behalf_of`

### `slack-agent-delivery-spec`

- Adopt all delivery rules (entry surfaces, status, finalized replies,
  continuation, reactions, footer metadata)
- Extend with: cross-user grant confirmation DM, ACL-denied UX,
  Dashboard deep-links in receipts

### `slack-outbound-contract-spec`

- Adopt entirely (markdown translation, file/reaction safety, error
  mapping). Slack-only commitment makes this load-bearing.

### `oauth-flows-spec`

- Adopt authorization code grant pattern
- Adopt MCP challenge-driven authorization
- Add: cross-user grant flow + grant revocation flow
- Slack app OAuth install lives in Dashboard, not in a CLI

### `sandbox-snapshots-spec`

- Adopt for CLI-fallback plugins only
- Drop Vercel Sandbox specifics
- Replace with Docker image layering + a small snapshot manifest

### `harness-agent-spec`, `harness-tool-context-spec`, `agent-execution-spec`

- Adopt as-is (rubric, completion gates, harness-owned tool targeting)
- The `advisor-tool-spec` is reference-only; not in v1

### `logging/`

- Adopt the entire OTel semantic taxonomy
- Add Sym-specific namespaces: `app.memory.*`, `app.soul.*`,
  `app.grant.*`, `app.dashboard.*`
- No external observability backend in v1; SDK exporter wired but
  defaults to no-op until configured

### `testing/`

- Adopt unit / integration / eval split
- Eval harness: **promptfoo** (self-hosted)
- Memory change policy, tone-rewrite, retrieval each get their own
  eval sets

## Glossary

- **Activity feed** — the live SSE stream of Sym events surfaced in
  the Dashboard.
- **Adapter** — the platform-facing layer in the Agent that translates
  Slack events to internal `Turn`/`Event` shapes and back. Slack-only
  in v1.
- **Agent (apps/agent)** — the Hono server that handles Slack ingress,
  runs the agent loop, and posts replies.
- **Change policy** — the four-state classifier (add/update/supersede
  /ignore) that decides what happens when new information arrives at
  memory.
- **Config-as-database** — the architectural choice that all Sym
  configuration lives in Postgres rows, not in yaml/markdown files.
  Dashboard writes, Agent reads.
- **Custom relational memory** — memory keyed on `(actor, subject)`
  for facts one user told Sym about another.
- **Dashboard (apps/dashboard)** — the Next.js admin surface; the
  control plane for all of Sym.
- **Egress proxy** — the HTTP proxy between sandbox and internet that
  injects credentials at request time.
- **Grant** — a time-boxed, scope-restricted permission for one user
  to use another user's OAuth-connected provider via Sym.
- **MCP** — Model Context Protocol. A standard for tool/resource
  servers consumed by agents.
- **Receipt** — a structured artifact attached to every visible reply
  describing what was recalled, called, and on whose behalf.
- **Slice** — one resumable chunk of a turn between two safe boundaries.
- **Soul layer** — a row in the `soul_layers` table at one of L0–L3
  that contributes to Sym's voice via cascade.
- **Substance-diff guard** — the check that tone-rewrite has not
  altered facts before delivery.
- **Two-server topology** — the v1 deployment shape: Dashboard +
  Agent as separate deployables, sharing Postgres + Redis.

## Related Specs (in this directory)

- `chat-architecture-spec.md`
- `agent-session-resumability-spec.md`
- `agent-prompt-spec.md`
- `agent-execution-spec.md`
- `harness-agent-spec.md`
- `harness-tool-context-spec.md`
- `skill-capabilities-spec.md`
- `plugin-spec.md`
- `security-policy.md`
- `oauth-flows-spec.md`
- `slack-agent-delivery-spec.md`
- `slack-outbound-contract-spec.md`
- `sandbox-snapshots-spec.md`
- `advisor-tool-spec.md`
- `logging/index.md`, `logging/logging-spec.md`, `logging/semantics.md`, `logging/tracing-spec.md`
- `providers/catalog-spec.md`
- `testing/index.md`, `testing/unit-spec.md`, `testing/integration-spec.md`, `testing/evals-spec.md`

## Open Decisions

These remain unresolved and are tracked here:

| Question | When to resolve |
| --- | --- |
| Default Fireworks model per task class (chat, tone-rewrite, summarization) | Tweakable in Dashboard; pick initial set before P02 |
| Cross-user grant Slack confirmation UX (ephemeral DM, visible thread, or both) | Before P04 |
| Change-policy thresholds for memory (2× vs 3× repetition, "refines" vs "contradicts" classifier) | Tunable per scope; iterate via promptfoo evals |
| Lightweight reporting metrics to surface in Dashboard | Design during P04 |
