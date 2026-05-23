# Sym Implementation Ideology + Build Plan

## Metadata

- Created: 2026-05-23
- Last Edited: 2026-05-23
- Status: **Active · working model for the Sym build**
- Owner: Sym authors

## Changelog

- 2026-05-23: Initial version. Captures the orchestrator-style build model
  (chunks of "1 working thing with end goal", parallel streams, no phases),
  the cross-unit impact discipline, the spine, the per-stream internal
  breakdowns, the dependency-ordered launch sequence, and the resolved +
  deferred open decisions.

---

## Status

Active working document. This is **not** a normative spec — the canonical
contracts live in `docs/specs/`. This document defines **how we build**:
the working model, the orchestration discipline, the chunk inventory, and
the sequencing. It changes as the build progresses and we learn.

---

## Working Model

We build in **chunks** of "1 working thing with an end goal." We do not
follow V1/V2 patterns, phases, or calendar-bound milestones. Sequence is
**dependency-driven**, not time-driven.

Within that model, we **orchestrate**:

- Identify the irreducible **spine** that has to land sequentially before
  anything else can fork.
- Identify **parallel streams** that fork once the spine is stable, each
  owning a clear end goal and a bounded interface.
- Lock the **cross-stream interfaces** in `@sym/contracts` before either
  side of an interface starts code, so parallel work cannot conflict.
- Apply **taste** — choose order, choose gates, choose what's good enough
  for a chunk's "working" state. Don't enumerate without recommending.

We always design for **production standards**. Every change is a
**multi-unit change**: when we modify a schema, a contract, or any shared
interface, we think through how every other unit reacts at every
intermediate deploy state. Discipline below.

---

## Cross-Unit Impact Discipline

Full reference: `.claude/skills/cross-unit-impact/SKILL.md`. The skill
must be run before any non-trivial change to schema, `@sym/contracts`, or
shared package interfaces.

Condensed rules:

1. **Name every consumer** of the unit you're changing — packages,
   services, deploys, external integrations.
2. **Backward compatibility is the default.** Old code + new state must
   work. New code + old state must work (for rollback).
3. **Non-trivial changes use expand-contract:**
   - **Expand** — add the new shape alongside the old.
   - **Migrate** — backfill + flip readers/writers one at a time.
   - **Contract** — drop the old shape only after grace + monitoring.
4. **Deploy order is documented.** Sym is two services on one Postgres;
   the order Dashboard ↔ Agent ↔ DB migration matters and must be stated
   on every PR.
5. **Rollback plan exists for every change.** If you can't roll it back,
   you can't deploy it (Honeycomb rule).
6. **Audit + OTel + eval** are added in the same PR as the behavior, not
   later.
7. **Schema rules:** additive by default; `NOT NULL` only after backfill;
   drops are two-phase; renames are three-phase; indexes `CONCURRENTLY`.
8. **Contracts rule:** consumer updates land in the same PR OR the old
   shape is `@deprecated` with a removal date.

Top-developer references in the skill: Stripe (date API versions),
Shopify (one-deploy-compat), gh-ost (online DDL), Honeycomb (rollback
discipline), Linear (cross-repo PR bot), DHH (every main commit
shippable), Google (contract-first review).

**PR template includes a "Cross-unit impact" section.** Every PR. From
PR #1.

---

## The Spine

Sequential. Must finish before any stream forks.

### Sp1 · Monorepo + tooling

**End goal:** `pnpm install && pnpm build && pnpm test` passes on empty repo.

1. `pnpm-workspace.yaml` + layout (`apps/*`, `packages/*`)
2. `turbo.json` pipeline (build, test, lint, typecheck, db:migrate)
3. Shared `tsconfig.base.json` + per-package extends
4. ESLint flat config + Prettier
5. Husky + lint-staged + commit-msg hook (conventional commits)
6. `.vscode/settings.json` pinning TS version + formatter
7. **PR template** including the Cross-unit impact section

**Cross-unit:** all packages inherit from these configs.

### Sp2 · `@sym/db` — schema + migrations

**End goal:** `pnpm db:migrate` on empty Postgres produces full schema;
`db:seed` inserts a test workspace; one round-trip Drizzle query works.

1. Drizzle setup (drizzle-kit, drizzle-orm/postgres-js, pg pool)
2. Schema files per domain:
   - `workspaces.ts` — workspaces, slack_installs
   - `acl.ts` — acl_rules
   - `admins.ts` — dashboard_admins (Clerk user mapping; see Decision D1)
   - `config.ts` — provider_configs, mcp_configs, skills
   - `soul.ts` — soul_layers
   - `memory.ts` — memory_entries (5 scopes + status)
   - `oauth.ts` — oauth_tokens (encrypted), grants
   - `runtime.ts` — tasks, checkpoints, conversations, messages
   - `audit.ts` — audit_events (hash chain), receipts
   - `leases.ts` — leases (turn-scoped credentials)
3. Migration runner (`drizzle-kit generate` + custom apply)
4. Seed scripts
5. Schema review session before any consumer starts

**Cross-unit:** the schema **is** the lingua franca. Every later schema
change runs the full schema-change subroutine.

**Note:** No `admin_sessions` table. Clerk manages sessions (D1).

### Sp3 · `@sym/contracts` — pure TypeScript types

**End goal:** every other package imports canonical types from one place.
Zero runtime, types only.

1. Branded ID types (`WorkspaceId`, `UserId`, `ChannelId`, `TurnId`,
   `SliceId`, `ClerkUserId`, etc.)
2. Domain: `Turn`, `Event`, `Reply`, `Message`, `Receipt`
3. Provider: `ProviderInterface`, `CompletionRequest`, `CompletionChunk`,
   `ToolDescriptor`
4. Tools: `ToolCall`, `ToolResult`, `ToolError`, `ToolDispatcher`
5. Memory: `MemoryScope`, `MemoryEntry`, `RetrievalRequest`,
   `RetrievalGate`
6. Soul: `SoulLayer`, `SoulCascade`, `ToneRewriteRequest`,
   `ToneRewriteResult`
7. Sandbox: `SandboxIdentity` (JWT shape), `LeaseRef`, `EgressRequest`
8. Audit: `AuditEvent`, `AuditEventKind`, `HashChainEntry`
9. Slack: `SlackTurnInput`, `SlackOutboundReply`, `SlackEntrySurface`
10. Errors: tagged unions for every cross-stream error

**Cross-unit:** every package depends on this; this depends on nothing.
**Owner:** one designated person merges; everyone else PRs into it.

### Sp4 · `@sym/secrets` — libsodium

**End goal:** encrypt/decrypt with a workspace key; Drizzle columns can
use it transparently.

1. libsodium-wrappers init + encrypt/decrypt-secretbox
2. Env loader for `SYM_ENCRYPTION_KEY` (32-byte base64, required)
3. Drizzle custom `encryptedText` type (encrypt on write, decrypt on read)
4. Key rotation primitive (dual-decrypt during migration)
5. Test vectors

**Cross-unit:** anything writing third-party tokens uses this.

---

## Streams — Parallel After Spine

Each stream has a fixed end goal. Internal pieces are listed in build
order. Cross-unit notes call out coordination points.

---

### S1 · Slack adapter (`@sym/adapter-slack`)

**End goal:** install app to a Slack workspace; `app_mention` and DM
events arrive as canonical `Turn`; outbound replies post in correct thread.

| # | Piece | What it is |
|---|---|---|
| 1 | **OAuth install** | App manifest, redirect handler, code-for-token exchange, persist bot token + workspace row via `@sym/secrets` |
| 2 | **Signing verification** | Verify Slack request signatures, reject ≥5s skew |
| 3 | **Event ingress** | Webhook endpoint, dedup by `event_id` (Redis), normalize to `Turn` |
| 4 | **Entry surface routing** | `app_mention` / DM / message shortcut / slash command → one `Turn` shape with `entrySurface` discriminant |
| 5 | **Outbound writer** | `chat.postMessage`, `chat.update`, `reactions.add`, `assistant.threads.setStatus`, exponential backoff |
| 6 | **Block Kit primitives** | Typed builders for header/section/context/divider/actions; never hand-build blocks |
| 7 | **Receipt footer renderer** | Take `Receipt` → render footer block |
| 8 | **App Home stub** | Minimal "open dashboard" + status |
| 9 | **Slash commands stub** | `/sym status` returning fixed message |

**Sequential within:** 1→2→3→4 unblocks events; 5→6→7 unblocks replies;
8 and 9 last.

**Cross-unit:**
- Writes `workspaces`, `slack_installs`, `oauth_tokens` (encrypted)
- Reads `acl_rules` to gate ingress
- Emits `Turn` / consumes `Reply` per Sp3
- Audit emit on every Slack write
- **Slack OAuth here is for the workspace bot install** — separate from
  the admin sign-in Slack OAuth that lives in Clerk (S3)

**Demoable end:** install → `@-mention` → "I heard you" echo reply
(stub kernel).

---

### S2 · Kernel + Fireworks (`@sym/kernel`, `@sym/provider-fireworks`)

**End goal:** given a `Turn`, produce a `Reply` via Fireworks; no tools.

| # | Piece | What it is |
|---|---|---|
| 1 | **Provider interface** in Sp3 | `complete(req) → AsyncIterable<CompletionChunk>`; `listTools()` |
| 2 | **Fireworks adapter** | OpenAI-compat client, streaming, error mapping, timeout, retry-on-429 |
| 3 | **System prompt assembler** | Byte-stable system block + per-turn context block |
| 4 | **Soul stub** | Returns L0 default until S7d ships |
| 5 | **Thin loop core** | Ingest Turn → assemble messages → call provider → extract Reply |
| 6 | **Slice/checkpoint hook** | Save/restore via S7c |
| 7 | **Tool registry interface** | Empty registry; tool calls fail closed until S5 |
| 8 | **Tone-rewrite hook** | Identity stub until S7d ships |
| 9 | **Receipt builder** | Collect what was used → produce `Receipt` for S1 |

**Cross-unit:**
- Consumes Turn (S1) + ProviderInterface (Sp3)
- Produces Reply (S1)
- Calls memory gate (S7a) — stub returns empty until S7a ships
- Audit emit (`gen_ai.*` + `app.*` semantic keys)
- **Fireworks tool-call payload shape** — see D2 (deferred)

**Demoable end:** `@-mention` Sym → Fireworks responds → reply posts.
No memory, no tools, no soul.

---

### S3 · Dashboard shell (`apps/dashboard`)

**End goal:** admin signs in via Clerk, lands on layout with sidebar nav;
every section is a placeholder route.

| # | Piece | What it is |
|---|---|---|
| 1 | **Next.js + Tailwind + shadcn** | App Router, TS, design tokens, base components |
| 2 | **Clerk integration** | `@clerk/nextjs` middleware; enable **only** Google + Slack OAuth providers in Clerk dashboard; disable email/password and other social providers |
| 3 | **Admin allowlist gate** | Either Clerk Organizations (one org per install, admins = org members) OR `dashboard_admins(clerk_user_id, email, role)` mapping table; gate every route; non-admins see "request access" page |
| 4 | **Layout shell** | Sidebar, top bar, theming, dark mode; Clerk `UserButton` in top bar |
| 5 | **Nav scaffolding** | Routes: Install, ACL, Provider, MCP, Skills, Soul, Memory, Audit, Activity |
| 6 | **Placeholder pages** | Each route renders "coming soon" until its owning stream fills it |
| 7 | **Activity SSE wiring** | Endpoint streams `audit_events` since cursor; empty stream OK |
| 8 | **Dashboard `/health`** | DB + Redis reachability check |

**Sequential within:** 1→2→3 unblocks auth; 4→5→6 unblocks navigation;
7 last.

**Cross-unit:**
- Reads `acl_rules` + `dashboard_admins` (or Clerk Org membership)
- Writes/reads config tables (used by S4)
- SSE endpoint coordinates with S7b audit broadcasts
- **Slack OAuth here = admin identity verification via Clerk**, distinct
  from the workspace bot install Slack OAuth in S1

**Demoable end:** open Dashboard → sign in with Google or Slack → see
empty layout with navigable sections.

---

### S4 · First-time settings (depends on S3 + Sp2)

**End goal:** admin pastes Fireworks key, picks model, installs Sym to
Slack from the Dashboard; Agent sees new config on next turn.

| # | Piece | What it is |
|---|---|---|
| 1 | **Onboarding wizard route** | Stepper: workspace → Slack → provider → ACL → done |
| 2 | **Slack install initiator** | Button kicks S1 OAuth flow; redirect-back lands in Dashboard |
| 3 | **Provider config form** | Fireworks key (libsodium-encrypted on save), model select per task class (chat / tone / summarize) |
| 4 | **ACL editor minimal** | Allowed-users list + admins list per overview spec |
| 5 | **Setup health indicator** | Each step shows green/yellow/red; setup-complete only when all green |
| 6 | **Re-entry guard** | After complete, navigate to main Dashboard; before complete, force the wizard |

**Sequential within:** 1→2 → 3→4 → 5→6.

**Cross-unit:**
- First real consumer of Sp2 config tables — exercising them forces
  them to be right
- Writes `provider_configs`, `acl_rules`, `slack_installs`
- Agent (S2) reads these on every turn; no cache, or invalidate-on-write
- Slack install handshake with S1's OAuth callback

**Demoable end:** brand-new install → wizard → Sym joins Slack → `@-mention` works.

---

### S5 · MCP + Skills (`@sym/ext-mcp`, `@sym/ext-skills`)

**End goal:** given an `mcp_configs` row, kernel can list+call MCP tools;
given a `skills` row, kernel can load skill content into context.

| # | Piece | What it is |
|---|---|---|
| 1 | **Tool dispatch contract** in Sp3 | `dispatch(call, sandboxCtx) → Promise<ToolResult>` |
| 2 | **MCP HTTP transport** | JSON-RPC, streaming |
| 3 | **MCP stdio transport** | Spawn process, framed messages, EOF handling |
| 4 | **MCP auth state in Redis** | Challenge-driven flow per `oauth-flows-spec`; TTL keys |
| 5 | **Tool registry impl** | Wraps MCP servers + skill activations; presents one unified registry to S2 |
| 6 | **Skill loader** | Pulls `skills` row, parses YAML frontmatter + markdown, returns `Skill` object |
| 7 | **Skill activation** | Lightweight pattern match; content injection into next turn's context |
| 8 | **Test stub MCP server** | No-op MCP server for E2E tests without network |

**Cross-unit:**
- Reads `mcp_configs`, `skills` (Sp2)
- Coordinates tool dispatch with S2 kernel + S6 sandbox
- Audit emit on every tool list / call
- **Skills never hold secrets** — enforced in loader

**Demoable end:** install a real MCP server → kernel calls a tool →
result returned. Enable a skill → see it activate next turn.

---

### S6 · Sandbox + egress (`@sym/sandbox`)

**End goal:** tool calls run in Docker+gVisor; outbound only via egress
proxy; proxy injects credentials from leases; sandbox sees no tokens.

| # | Piece | What it is |
|---|---|---|
| 1 | **Sandbox identity** in Sp3 | JWT shape, claims (`sandbox_id`, `requester`, `turn_id`, `nbf`/`exp`) |
| 2 | **Docker spawn primitive** | Base image, ephemeral overlay, no-network namespace |
| 3 | **gVisor runtime wiring** | `runsc` runtime, syscall filter, drop capabilities |
| 4 | **JWT minter** | Spawner mints short-lived JWT; placed in sandbox env, never written to disk |
| 5 | **Egress proxy service** | Hono service, JWT verify, lease lookup, header injection, hop-by-hop strip |
| 6 | **Lease store** | Hot in-memory + Postgres encrypted backup; TTL = turn duration |
| 7 | **Lease issuer** | Called by tool dispatcher before sandbox spawn; writes leases for `(requester, provider, domain)` |
| 8 | **Audit every outbound** | Destination, status, byte counts |
| 9 | **Network topology** | sandbox → proxy only; proxy → internet only; nothing else reaches proxy |

**Cross-unit:**
- Consumed by S5 tool dispatcher
- Reads `oauth_tokens`, `grants` to materialize leases
- The most security-sensitive code in Sym; **every PR gets explicit
  security review**
- **Long pole** — start the day spine lands

**Demoable end:** kernel triggers a tool call → sandbox spawns → tool
hits internet through proxy → result returns → sandbox tears down → no
token leaked into any log.

---

### S7a · Memory (`@sym/memory`)

**End goal:** 5-scope retrieval gate enforces visibility; change-policy
classifier writes correctly per evals.

| # | Piece | What it is |
|---|---|---|
| 1 | **Memory schema** in Sp2 | Stream owns the access layer, not the schema |
| 2 | **Retrieval gate** | `getMemories(requester, scopeFilter, perms) → MemoryEntry[]` — runs in code, not in prompt |
| 3 | **Eval set scaffolding** | promptfoo config + first 20 cases for change classifier |
| 4 | **Change-policy classifier** | `classify(turn, candidate, existing) → add | update | supersede | ignore` |
| 5 | **Writer** | Apply classification: insert, update with audit trail, mark superseded |
| 6 | **Custom-relational consent** | Subject acceptance flow + retrieval block when not accepted |
| 7 | **Cross-scope CI red-team** | Test that custom-relational memories never leak to non-subjects |
| 8 | **Memory viewer endpoint** | Powers Dashboard memory browser |

**Sequential within:** 2 first (gate before reads); **3 before 4**
(evals are the spec for the classifier); 4→5; 6 parallel; 7 non-negotiable
CI gate; 8 last.

**Cross-unit:**
- Consumed by S2 kernel for context assembly
- Writes audit on every memory mutation
- Eval thresholds tracked in promptfoo and tunable per workspace later

**Demoable end:** during a conversation, Sym remembers a preference; in
the next conversation, recall reflects it. Cross-scope test: User A's
memory about User B is invisible to User C.

---

### S7b · Audit + receipts (`@sym/audit`)

**End goal:** hash-chained audit log; receipts on every visible reply;
OTel emitters firing with the right semantic keys.

| # | Piece | What it is |
|---|---|---|
| 1 | **Schema** in Sp2 | `audit_events(id, prev_hash, this_hash, kind, actor, on_behalf_of, payload_json, ts)` |
| 2 | **Append primitive** | Atomic insert with `prev_hash` lookup; serialized per workspace |
| 3 | **Hash-chain verifier** | Walk chain, detect any break; CI test on seeded chain |
| 4 | **Receipt formatter** | Query turn's audit entries → render structured `Receipt` |
| 5 | **OTel SDK wiring** | Tracer + meter; semantic conventions per `specs/logging/` |
| 6 | **No-op exporter default** | OTel collects but doesn't export until configured |
| 7 | **SSE broadcaster** | Tap audit appends → broadcast to Dashboard activity feed |
| 8 | **Export tool** | Admin can download full chain (JSON or hash-verified bundle) |

**Cross-unit:**
- Every stream emits; universal consumer
- Hash chain is per workspace, never cross-workspace
- Used by S3 (activity feed), S1 (receipt footer), every audited op

**Demoable end:** every turn produces a Slack-visible receipt; Dashboard
activity feed shows live events; hash-chain verifier passes on prod data.

---

### S7c · Tasks (`@sym/tasks`)

**End goal:** durable queue + slice/checkpoint primitive; turns can be
suspended and resumed.

| # | Piece | What it is |
|---|---|---|
| 1 | **Schema** in Sp2 | `tasks(id, kind, payload_json, status, due_at, attempts)` + `checkpoints(slice_id, kernel_state_blob, version)` |
| 2 | **Enqueue/dequeue** | SELECT FOR UPDATE SKIP LOCKED Postgres-native queue |
| 3 | **Worker loop** | Polls due tasks, dispatches per kind, marks done/failed |
| 4 | **Slice/checkpoint serializer** | Kernel state ↔ blob; version-tagged |
| 5 | **HMAC timeout callbacks** | Signed URL callers can hit to resume a slice |
| 6 | **Idempotency keys** | Same callback twice = one effect |
| 7 | **Retry policy** | Exponential backoff, dead-letter after N |

**Cross-unit:**
- Consumed by S2 kernel for slice/checkpoint
- Future task chunks (digest, pr-watcher) build on this
- Audit on every state transition

**Demoable end:** schedule a task 5 min out → it fires → audit + receipt
land. Kill the Agent mid-slice → restart → slice resumes.

---

### S7d · Soul + tone-rewrite

**End goal:** L0–L3 cascade resolves into effective soul; tone-rewrite
stage runs post-reply; substance-diff guard rejects fact-changing
rewrites.

| # | Piece | What it is |
|---|---|---|
| 1 | **Schema** in Sp2 | `soul_layers(layer, scope_id, content_md, updated_at)` |
| 2 | **L0 default** | Built-in `sym.soul.md` — global posture, never edited at runtime |
| 3 | **Cascade resolver** | For `(workspace, channel, user)` → merged effective soul |
| 4 | **Cache by updated_at** | Per-conversation cache, invalidate on layer write |
| 5 | **Tone-rewrite stage** | Draft reply + soul → rewritten reply via cheaper model |
| 6 | **Substance-diff guard** | Extract facts from draft + rewrite; if facts differ → reject, deliver original |
| 7 | **Eval set** | promptfoo cases for cascade correctness + guard accuracy |
| 8 | **Soul editor in Dashboard** | L1/L2/L3 CRUD with cascade preview (later chunk; this stream just exposes API) |

**Sequential within:** 2 first; 3→4; 5 parallel; **6 before wiring to
S2**; 7 alongside 5+6; 8 last.

**Cross-unit:**
- Called by S2 kernel as post-reply stage
- Reads `soul_layers`; written by S3/S4 Dashboard
- Substance-diff guard is the highest-stakes code here — eval-driven

**Demoable end:** set workspace tone "formal" → reply is formal. Channel
override "casual" → channel reply is casual but workspace stays formal.
Inject fact-change via rewrite → guard catches it.

---

### S8 · DevEx / CI / Deploy

**End goal:** empty repo → green CI on push → Dokploy deploys both apps
→ smoke test passes.

| # | Piece | What it is |
|---|---|---|
| 1 | **GitHub Actions workflows** | `ci.yml`: install → typecheck → lint → test → build (turbo affected) |
| 2 | **Postgres + Redis dev setup** | Install scripts for macOS + Linux; **native, not Docker** |
| 3 | **Drizzle CLI shortcuts** | `pnpm db:migrate`, `db:seed`, `db:reset`, `db:studio` |
| 4 | **Local dev compose** | `docker-compose.yml` for engineers who can't run native pg/redis (optional) |
| 5 | **Dokploy config** | App-per-deployable, env injection, deploy hooks |
| 6 | **Deploy ordering enforcer** | DB migration → Dashboard → Agent (documented + enforced in Dokploy pipeline) |
| 7 | **promptfoo CI** | Eval sets run on PRs touching their producing package (turbo affected) |
| 8 | **Pre-commit hooks** | lint-staged: format + typecheck the changed file's package |
| 9 | **Smoke test job** | Post-deploy: `/health` on both apps; fail deploy if not green |
| 10 | **PR template** | Includes Cross-unit impact section automatically |

**Cross-unit:** owns deploy ordering, owns migration safety enforcement,
owns the PR template. Outputs are dependencies for every other stream's
day-to-day workflow.

**Demoable end:** push to main → CI green → Dokploy deploys → smoke
green → Dashboard URL works → Slack install works.

---

## Dependency-Ordered Launch Sequence

Calendar days are scaffolding for ordering; chunks ship when they ship.

```
DAY 1 ──── Sp1 (monorepo + tooling, PR template)
DAY 2-3 ── Sp2 (schema) ‖ Sp3 (contracts) — designed & reviewed together
DAY 4 ──── Sp4 (secrets)
DAY 5 ──── ┌── S1 (Slack adapter)
           ├── S2 (Kernel + Fireworks)
           ├── S3 (Dashboard shell + Clerk)
           ├── S6 (Sandbox + egress)  ◀── long pole, start NOW
           └── S8 (CI/CD + PR template enforcement)
DAY ~8 ─── S4 (first-time settings) — needs S3 shell ready
DAY ~14 ── 🎯 MILESTONE 1: install → @-mention → Fireworks reply
DAY 15+ ── ┌── S5 (MCP + skills)
           ├── S7a (memory)
           ├── S7b (audit + receipts)
           ├── S7c (tasks)
           └── S7d (soul + tone)
DAY ~30 ── 🎯 MILESTONE 2: tool call end-to-end with audit + receipt
DAY ~45 ── 🎯 MILESTONE 3: memory + soul + grants observable in Slack
```

The dependency order is what keeps parallel work un-conflicted.

---

## Taste Calls

1. **Schema review on Sp2 is the highest-leverage hour in the project.**
   Block calendar time, walk every table with every consumer present.
2. **Sp3 contracts gets one designated merger.** Everyone else PRs into it.
3. **S6 starts day 5.** Don't wait until "we need it" — by then you're
   blocked.
4. **S7a evals before classifier.** Non-negotiable. Code without evals
   is a guess.
5. **Audit + OTel are not a stream — they're a discipline.** Every
   stream emits from day 1.
6. **Hold S5 until S1+S2 produce the first reply.** Until then, tool
   dispatch is conjectural and premature contracts leak.
7. **PR template (S8 piece 10) ships with Sp1.** Cross-unit-impact
   discipline enforced from PR #1.
8. **Two OAuth surfaces, never conflate:**
   - **Slack workspace install** (S1) — installs the bot, persists bot
     token, lives in `slack_installs`.
   - **Slack admin sign-in via Clerk** (S3) — verifies admin identity,
     no bot token, lives in Clerk + `dashboard_admins`.

---

## Decisions

### D1 · Dashboard admin sign-in: Clerk (resolved 2026-05-23)

Dashboard uses **Clerk** for auth, with **Google OAuth + Slack OAuth as
the only enabled identity providers**. Email/password and other social
providers are disabled in Clerk config.

Admin access is **restricted** — not all workspace users can reach the
Dashboard. Admins are explicitly granted via Clerk Organizations (one org
per Sym install) or a `dashboard_admins` mapping table — implementer
picks at S3 build time; Clerk Orgs preferred for single-tenant.

Slack OAuth in Clerk is for **admin identity verification only**,
separate from the workspace bot install OAuth in S1. Different scopes,
different tokens, different tables. Do not conflate.

Implications:
- No custom `admin_sessions` table.
- `@clerk/nextjs` middleware on all Dashboard routes except public landing.
- Non-admins hit a "request access" page, never a partial Dashboard view.

### D2 · Fireworks tool-call payload compatibility (deferred)

Whether Fireworks' tool-call format matches OpenAI's exact shape needs
research at the point S2's `ProviderInterface` is being finalized for
tool support. Cannot decide today; not blocking until S5 wires through.

When researching: confirm the request shape (`tools` array structure,
required fields), the response shape (`tool_calls` in message), and
streaming behavior (do tool call args stream as deltas?). Adjust the
`ProviderInterface` flex if needed.

---

## Open Items (re-check as work progresses)

| Item | Triggers re-check |
|---|---|
| Default Fireworks model per task class (chat / tone / summarize) | Before S2 first reply |
| Cross-user grant Slack confirmation UX | Before S5 tool calls reach the grants flow |
| Change-policy thresholds for memory (2× vs 3× repetition) | Tunable per scope; iterate via promptfoo evals during S7a |
| Lightweight Dashboard reporting metrics | Once S7b audit is emitting |
| Clerk Organizations vs custom `dashboard_admins` mapping | Decide at S3 piece 3 build time |
| Fireworks tool-call payload compatibility (D2) | Before S5 tool wiring lands |

---

## Glossary

- **Spine** — the irreducibly sequential set of chunks (Sp1–Sp4) that
  must finish before any stream forks.
- **Stream** — a parallel work unit (S1–S8) with one end goal and a
  bounded interface.
- **Chunk** — "1 working thing with an end goal." Either a spine item or
  a piece inside a stream.
- **Cross-unit impact** — the discipline that every change is evaluated
  for its effect on every consuming unit, with explicit expand-contract
  + deploy-order + rollback plans.
- **Demoable end** — the observable state that proves a chunk shipped.
- **`@sym/contracts`** — the pure-types package every other package
  depends on; the lever that makes parallel work conflict-free.

---

## Related

- `docs/specs/sym-overview-spec.md` — product thesis + hard architectural
  decisions (single source of truth for what we're building).
- `docs/specs/index.md` — canonical spec index.
- `docs/specs/AGENTS.md` — spec conventions (this doc is not a spec).
- `.claude/skills/cross-unit-impact/SKILL.md` — the discipline applied
  on every PR.
- `docs/ideation.html` — original ideation; superseded for HOW-we-build
  by this document.
