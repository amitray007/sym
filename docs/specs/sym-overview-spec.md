# Sym Overview Spec

## Metadata

- Created: 2026-05-23
- Last Edited: 2026-05-23
- Status: **Draft · v0.1 · pre-implementation**
- Owner: Sym authors

## Changelog

- 2026-05-23: Initial draft. Captures the consolidated design decisions
  from the ideation discussions through this date. Derives reference
  contracts from [getsentry/junior](https://github.com/getsentry/junior)
  specs copied into `docs/specs/`, with explicit Sym deltas listed below.

## Status

Active design record. This spec is the canonical entry point for the
detailed contracts. It enumerates what Sym is, what it ships in v1, and
where its contracts diverge from the upstream Junior specs that are
preserved alongside it in this directory.

This spec exists so engineering and design conversations have a single,
authoritative reference. Individual contracts (memory model, plugin
contract, OAuth flow, etc.) get their own Sym-specific spec files as
they are written; this overview is the index and the rationale.

## Purpose

Define, in one document:

- The product thesis of Sym
- The hard product decisions for v1 (Slack-only, single-tenant, etc.)
- The architectural contracts at the *overview* level
- The Sym-specific deltas against each adapted Junior spec
- The phased build plan and "what we own" boundary

## Scope

- v1 product surface and constraints
- Runtime architecture at the package/module level
- Memory model, soul cascade, plugin model, trust boundary
- Provider, sandbox, and storage choices
- Build sequence and ownership boundaries

## Non-Goals

- Defining individual tool schemas or prompt prose. Those belong in
  per-subject specs and the runtime code respectively.
- Defining Slack API contracts in detail. The `slack-agent-delivery-spec`
  and `slack-outbound-contract-spec` adapted from Junior own those, with
  Sym deltas noted there.
- Defining specific eval criteria. Those live with the eval harness.

## Product Thesis

Sym is an AI teammate that lives in a team's Slack workspace. **Not a
bot, not a search tool — a teammate.** Joins channels, holds opinions,
remembers what matters, owns tasks, is accountable for everything it
does. Trust is a system property: scope discipline, provenance,
auditability, reversibility, compliance. Where trust and capability
conflict, trust wins.

The "teammate test" is the cheapest correctness rubric: *would a
thoughtful new hire do this?* If no, Sym doesn't either.

## v1 Hard Decisions

The following are **hard architectural commitments** for v1. Reversing
any of them is a v2-class change.

### Tenancy

- **One Sym install = one Slack workspace.** Single-tenant by design.
- Multi-tenancy is an ops concern (multiple installs), not a code
  concern. No tenant-keying inside the data model.

### Surface

- **Slack only.** No adapter abstraction, no Teams, no Discord, ever.
- The Slack adapter is Slack-deep: Block Kit, modals, App Home, slash
  commands, message shortcuts, reactions, canvases, Lists.

### Deployment

- **No Vercel coupling.** We ship our own infra:
  - Web framework: Hono
  - Sandbox: Docker + gVisor
  - Egress proxy: our own Hono service with JWT auth from sandbox
  - Storage: Postgres (durable) + Redis (hot/ephemeral)
- Compose for dev, Helm chart for prod. No `VERCEL_*` env paths.

### Provider

- **Default: Fireworks**, accessed via its OpenAI-compatible interface.
- Provider interface lives inside `@sym/kernel`; second provider
  extracts it.
- Future providers (OpenAI, Anthropic, Cerebras, custom URLs) implement
  the same interface and live in their own packages when they ship.
- Subscription-based providers (Claude / Codex CLI) are deferred to
  v1.x as opt-in, experimental packages.

### Agent Loop

- **Custom thin agent loop** (~500 lines) directly on the provider SDK.
- No Pi, no Vercel AI SDK, no LangChain.
- Slice/checkpoint is **our** primitive — adapted in shape from Junior's
  contract but implemented entirely in our code.

### Storage

| Workload | Store |
| --- | --- |
| Memory (5 scopes) | Postgres |
| Tasks (durable queue + checkpoints) | Postgres |
| Audit log + receipts | Postgres |
| Conversation transcript | Postgres |
| OAuth tokens | Postgres |
| Vector recall (when added in v1.x) | pgvector on Postgres |
| Per-thread locks | Redis |
| Rate-limit buckets | Redis |
| OAuth state TTL (10-min) | Redis |
| MCP auth session state | Redis |

### Telemetry

- OpenTelemetry SDK throughout.
- Semantic key sets: `gen_ai.*`, `app.credential.*`, `app.memory.*`,
  `app.soul.*`, `messaging.*`.
- Single event stream → audit log + receipts + Dashboard feed.

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

The **custom relational** scope is novel and replaces what Junior calls
"thread-context." It is keyed on `(actor_id, subject_id)` and has its
own consent rules (subject must accept or the memory is not retrievable
when subject queries).

### Formation policy

Memory is only written when behaviour is *substantial*. The formation
policy is a hard gate before any memory write reaches storage.

Memory **is** formed when:
- User explicitly signals: "remember this" / "from now on" / "always" / "never"
- A fact is mentioned ≥2× across turns or channels
- A preference statement is detected: "I prefer X" / "Always X" / "Never X"
- A tool-call habit is detected: same flow run ≥3 times

Memory is **never** formed when:
- A fact is mentioned once in passing
- The exchange is chitchat / banter / jokes
- The candidate is Sym's own output (no self-referential memory)
- The originating tool call failed

The policy is encoded as `should_form_memory(turn, candidate) → bool`
and evaluated against an eval set kept alongside the kernel package.
Getting this wrong floods memory with noise; getting it right is a
differentiator.

### Retrieval gate

Every recall passes a gate that takes `(requester, scope_filter,
permissions)` and returns only entries the requester is allowed to see.
The gate runs in `@sym/memory`, not in the agent prompt. CI red-team
test suite verifies no cross-scope leakage.

## Soul Cascade

Sym's voice is layered across `.soul.md` files using CSS-like cascade.
More-specific files override less-specific ones, applied by the runtime
as a **tone-rewrite stage** after the agent produces draft text.

| Layer | File | Scope |
| --- | --- | --- |
| L0 | `sym.soul.md` | Global teammate posture — hedge, confirm destructive, never confabulate |
| L1 | `workspace.soul.md` | Workspace tone floor (casual / neutral / formal) |
| L2 | `channel/<name>.soul.md` | Per-channel override (admin or auto-suggested) |
| L3 | `user/<id>.soul.md` | Per-user preference (set via DM, stored in DM-scope memory) |

A **substance-diff guard** runs before the rewritten output is
delivered: if the rewrite changes factual content (vs. just tone),
it is rejected and the original text is delivered.

Memory and soul are strictly separated stores. Memory is *facts*; soul
is *voice*.

## Plugin Model · MCP-first + CLI-fallback

Extensions to Sym arrive in three shapes:

1. **MCP servers** — declarative config in `mcps.yaml`. No code.
   First-class for any provider with an MCP server.
2. **CLI-fallback plugins** — `plugin.yaml` with `runtime-dependencies`
   that get installed inside the sandbox. Required when no MCP server
   exists for a provider. Carries some of Junior's plugin complexity
   forward (sandbox snapshots, command-env, etc.).
3. **Skills** — `SKILL.md` markdown files with YAML frontmatter.
   Workflow guidance — *how* to do a domain task. Loaded on demand by
   the agent. Never holds secrets.

The catalog that ships with v1 is documented in `apps/reference/config/`.

### Per-user OAuth + Cross-user grants

Each user OAuths their own provider accounts. Sym stores tokens by
`(user_id, provider)`. When User A asks Sym to do GitHub work, Sym
uses User A's token.

When User A wants to let User B use their access, User A issues a
**grant**:

- Time-boxed (default 24h, max 7d)
- Scope-restricted (cannot exceed grantor's OAuth scope)
- Revocable by grantor at any time
- Non-transitive (User B cannot re-grant to User C)
- Every use audited with `actor + on_behalf_of` attribution

Grants are stored in `mcp_grants(grantor, grantee, mcp, scope, expires_at)`.

## Trust Boundary · Sandbox + Egress

Tools run inside a per-turn **Docker + gVisor sandbox**. The sandbox:

- Is ephemeral (destroyed at end of turn)
- Has an isolated network namespace
- Routes all outbound traffic through Sym's egress proxy

The **egress proxy**:

- Verifies the sandbox identity (short-lived JWT minted at spawn)
- Looks up the credential lease for `(requester, provider, domain)`
- Injects auth headers at request time
- Strips hop-by-hop and proxy-control headers
- Logs every outbound call to `@sym/audit`

The model never sees tokens. The sandbox filesystem never holds tokens.
Tokens live only in the proxy's in-memory lease store, valid only for
the active turn.

## Access Control

Sym ships an ACL gating both Slack and Dashboard access. Modes:

| Mode | Slack interaction | Dashboard access |
| --- | --- | --- |
| `open` | Anyone in workspace | Configured admins |
| `allowlist` | Only listed users | Listed admins |
| `workspace_minus_blocked` | Workspace minus blocked | Listed admins |

Stored as `(workspace_id, user_id, role, status)`. Dashboard access is
always narrower than or equal to Slack access by policy.

## Proactivity Policy

Sym **does not speak unprompted** in v1. Allowed triggers:

| Trigger | When |
| --- | --- |
| Direct `@-mention` | Anywhere Sym is invited |
| DM | Without `@-mention` |
| Task-fired output | A registered task fires (`pr-watcher`, `digest`, etc.) |

Future tiers (v1.x+) add "watcher actions earn authority to speak,"
gated by the Dashboard. v2+ adds dashboard-defined trigger rules.

## Surfaces

### Primary · Slack (rich-native)

We use every relevant Slack API surface:

- Block Kit Builder layouts (sections, dividers, context blocks, buttons)
- Modals (`views.open`) for confirmations
- Interactive elements (buttons, datepickers, selects)
- Slack Canvases for long-form output
- Slack Lists for tracked items
- App Home tab as the admin surface
- Slash commands (`/sym connect`, `/sym status`, `/sym forget`)
- Message shortcuts ("Send to Sym", "Watch this")
- Reactions (`:eyes:` processing, `:white_check_mark:` done, `:thinking_face:` reasoning)
- Live status (`assistant.threads.setStatus`) with phase labels
- Files API for uploaded artifacts

### Operator · Sym Dashboard

A web admin surface — the layer where the team sees everything Sym
knows, has done, and is permitted to do.

v1 (read-mostly):
- Live activity feed
- Memory viewer (per scope) + forget actions
- Audit log + receipts (exportable)
- Connected accounts + grants (read-only)
- Telemetry (live OTel traces, latency, cost)
- Tasks (active watchers, schedules, history)

v1.x (configure):
- Allowed-users ACL editor
- Soul file editor with cascade preview
- MCP install + uninstall
- Proactivity rule editor

## Architecture Overview

```
slack → adapter → runtime ─┬─ skills · mcp · cli (per-user oauth + grants)
                           │
                           ├─ memory + soul (5 scopes · cascading voice)
                           │
                           └─ tasks · resume (durable · slice/checkpoint)
                                            │
                                            ▼
                                   audit · receipts · OpenTelemetry
                                            │
                                            ▼
                                      sym dashboard feed
```

Runtime contains: agent loop · tone-rewrite stage · per-turn sandbox
with egress proxy that injects credential leases. Audit spine feeds
both the durable audit log and the live Dashboard activity feed.

## Package Layout

```
sym/
├── apps/
│   ├── reference/           the Sym we dogfood (deployable)
│   └── dashboard/           the web admin UI
├── packages/
│   ├── kernel/              @sym/kernel
│   ├── state/
│   │   ├── memory/          @sym/memory
│   │   ├── tasks/           @sym/tasks
│   │   └── audit/           @sym/audit
│   ├── runtime/
│   │   └── sandbox/         @sym/sandbox
│   ├── providers/
│   │   └── fireworks/       @sym/provider-fireworks
│   ├── adapters/
│   │   └── slack/           @sym/adapter-slack
│   └── ext/
│       ├── mcp/             @sym/ext-mcp
│       ├── skills/          @sym/ext-skills
│       └── cli-plugin/      @sym/ext-cli-plugin
├── docs/
│   ├── ideation.html
│   └── specs/               adapted from Junior, plus our own
├── pnpm-workspace.yaml
└── turbo.json
```

## Build Sequence

Three phases, ~10 weeks to pilot with 2 engineers.

### Phase 01 · weeks 1–3 · Kernel + the loop

- `@sym/kernel` interfaces and thin agent loop on Fireworks
- `@sym/adapter-slack` ingress + basic posting + App Home stub
- `@sym/ext-mcp` MCP client (HTTP + stdio transports)
- `@sym/ext-skills` SKILL.md loader
- One real end-to-end: `@-mention` → Fireworks reply → 1 MCP tool call
- Smoke deploy on our own Docker infra

### Phase 02 · weeks 4–7 · Trust + state

- `@sym/memory` 5 scopes + retrieval gate + formation policy
- `@sym/tasks` Postgres queue + slice/checkpoint contract
- `@sym/sandbox` Docker + gVisor + egress proxy + leases
- `@sym/audit` hash chain + OTel emitters + receipt formatter
- Per-user OAuth flow + cross-user grants table

### Phase 03 · weeks 8–10 · Catalog + dashboard

- Wire MCP servers: GitHub · Linear · Calendar · Sentry
- Ship skills: `digest`, `pr-watcher`, `summarize`, `onboard`
- Tone-rewrite stage with substance-diff guard
- Sym Dashboard read-mostly v1 (activity, memory, audit, telemetry)
- Allowlist + restricted-users config

## Deltas Against Junior Specs

Reference contracts adapted from
[getsentry/junior](https://github.com/getsentry/junior) are preserved
in this directory. Sym-specific divergences:

### `chat-architecture-spec`

- Single-tenant per install (drop tenant-keying)
- One adapter (Slack), no `chat/runtime/<surface>/` per-surface split
- Postgres for all durable state (drop Redis split for transcript +
  session — Redis only for hot/ephemeral)
- No Pi session state — our own slice/checkpoint instead

### `agent-session-resumability-spec`

- Adopt slice/checkpoint shape (same `conversation_id` / `session_id`
  / `slice_id` / `checkpoint_version`)
- Drop Pi `replaceMessages` + `continue()` mechanics — our own loop
  uses provider SDK directly
- Same HMAC-signed timeout callbacks
- Same "no auto-resume after visible output" rule

### `agent-prompt-spec`

- Adopt byte-stable system prompt + per-turn context separation
- Drop deployment-stable `SOUL.md` model in favor of the **cascading**
  soul layers (L0–L3)
- Tone-rewrite is a runtime stage, not prompt prose

### `skill-capabilities-spec`

- Adopt lease-based credentials + egress proxy pattern
- Drop Vercel Sandbox OIDC; use our own JWT minted by sandbox spawner
- Add cross-user grant model (new)
- Keep `runtime-dependencies` + `command-env` for CLI-fallback path
- Keep `sandbox-snapshots` for CLI-heavy plugins

### `plugin-spec`

- MCP-first: most extensions are config in `mcps.yaml`, no plugin code
- CLI-fallback retains `plugin.yaml` shape for installable CLIs
- Drop `${NAME}` expansion mini-language — env passed by runtime
- Skills stay as `SKILL.md` files (markdown + frontmatter)

### `security-policy`

- Adopt every principle (least privilege, short-lived creds, isolation)
- Replace Vercel-specific egress paths with our Docker + gVisor + JWT
- Add cross-user grant audit rule: every cross-user call must log
  `actor` + `on_behalf_of`

### `slack-agent-delivery-spec`

- Adopt all delivery rules (entry surfaces, status, finalized replies,
  continuation, reactions, footer metadata)
- Extend with: cross-user grant prompts, ACL-denied UX, dashboard
  deep-links in receipts

### `slack-outbound-contract-spec`

- Adopt entirely (markdown translation, file/reaction safety, error
  mapping). Slack-only commitment makes this load-bearing.

### `oauth-flows-spec`

- Adopt authorization code grant pattern
- Adopt MCP challenge-driven authorization
- Add: cross-user grant flow + grant revocation flow

### `sandbox-snapshots-spec`

- Adopt for CLI-fallback plugins only
- Drop Vercel Sandbox specifics
- Replace with Docker image layering + a small snapshot manifest

### `harness-agent-spec`, `harness-tool-context-spec`, `agent-execution-spec`

- Adopt as-is (rubric, completion gates, harness-owned tool targeting)
- The `advisor-tool-spec` is reference-only; we don't ship advisor
  tools in v1

### `logging/`

- Adopt the entire OTel semantic taxonomy
- Add Sym-specific namespaces: `app.memory.*`, `app.soul.*`,
  `app.grant.*`, `app.dashboard.*`

### `testing/`

- Adopt the unit / integration / eval split
- Memory formation gets its own eval set

## Glossary

- **Adapter** — the platform-facing layer that translates Slack events
  to internal `Turn`/`Event` shapes and back. Slack-only in v1.
- **Custom relational memory** — memory keyed on `(actor, subject)` for
  facts one user told Sym about another.
- **Egress proxy** — the HTTP proxy between sandbox and internet that
  injects credentials at request time.
- **Formation policy** — the `should_form_memory()` gate that decides
  if a candidate becomes durable memory.
- **Grant** — a time-boxed, scope-restricted permission for one user
  to use another user's OAuth-connected provider via Sym.
- **MCP** — Model Context Protocol. A standard for tool/resource
  servers consumed by agents.
- **Receipt** — a structured artifact attached to every visible reply
  describing what was recalled, called, and on whose behalf.
- **Slice** — one resumable chunk of a turn between two safe boundaries.
- **Soul layer** — a `.soul.md` file at one of L0–L3 that contributes
  to Sym's voice via cascade.
- **Substance-diff guard** — the check that tone-rewrite has not
  altered facts before delivery.
- **Sym Dashboard** — the web admin surface for activity, memory,
  audit, telemetry, and configuration.

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

These remain unresolved and are tracked here as the canonical question
list (mirrored to the ideation page open-questions section):

| Question | When to resolve |
| --- | --- |
| Fork Junior or build clean? | 1-week Junior pilot first, then decide |
| Pricing model (per-seat, per-team, usage, hybrid) | Before pilot kickoff |
| Fireworks default model (Llama, Qwen, DeepSeek) | Before phase 01 wraps |
| Cross-user grant UX (Slack modal vs Dashboard) | Before phase 02 |
| Keep "Sym" name or rebrand at launch | Low urgency |
