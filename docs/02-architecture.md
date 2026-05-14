# 02 — Architecture

## Goals

The architecture exists to serve three properties, in order:

1. **Trust.** Scope partitioning, audit, reversibility must be
   enforceable at the layer they belong to, not "trusted to the model."
2. **Continuity.** Memory, tasks, and identity survive process restarts,
   platform reconnects, and platform switches.
3. **Velocity.** New skills, new platforms, new model providers can ship
   without a rewrite.

## System sketch

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Platform Adapters                            │
│   Slack (events, RTM, oauth) │ Teams (Bot Framework) │ Discord (gw)  │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ normalized events
┌──────────────────────────────────────────────────────────────────────┐
│                         Ingress / Routing                            │
│  identity resolution │ workspace lookup │ rate & budget gates        │
│  mention / DM detection │ channel-policy lookup │ trace start        │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          Agent Runtime                               │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────────┐   │
│  │ Conversation│  │ Prompt       │  │ Tool dispatch              │   │
│  │ state       │◄─┤ assembly +   ├─►│ (skills, MCPs, builtins)   │   │
│  │ (thread)    │  │ tone calib   │  │                            │   │
│  └─────────────┘  └──────────────┘  └────────────────────────────┘   │
│                          ▲   ▲                                       │
│                          │   │                                       │
│                          │   └── memory retrieval (scoped)           │
│                          └────── system prompt (per-channel)         │
└──────────────────────────────────────────────────────────────────────┘
            │                   │                  │
            ▼                   ▼                  ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│ Memory service   │  │ Skill / MCP      │  │ Task service          │
│ (scoped stores)  │  │ registry         │  │ (durable, resumable)  │
└──────────────────┘  └──────────────────┘  └──────────────────────┘
            │                   │                  │
            └────────────┬──────┴──────────────────┘
                         ▼
              ┌──────────────────────┐
              │ Audit & Observability│
              │ (event log, traces)  │
              └──────────────────────┘
```

## Layer by layer

### 1. Platform adapters

Each adapter is a thin module that:

- Authenticates the workspace (OAuth handshake, app install, scopes).
- Subscribes to events: messages, mentions, reactions, joins, slash
  commands, thread replies.
- Normalizes events to a shared schema (`NormalizedEvent`).
- Exposes platform-specific actions (send message, react, create
  thread, post canvas/card, ephemeral DM).

See `08-platform-adapters.md` for the shared schema and per-platform
quirks. Slack is the reference adapter.

### 2. Ingress / routing

The ingress is the only public-facing layer. It:

- Verifies signatures (Slack signing secret, Teams JWT, Discord
  Ed25519).
- Resolves identity: platform user → organization identity. Uses
  SSO/SCIM where available, email-fallback otherwise.
- Looks up the workspace, its policy, its budget envelope, its
  feature flags.
- Decides whether the event should reach the agent (mention? DM?
  channel-policy match? rate limit?).
- Starts a trace (`trace_id`) that follows the request through every
  subsequent layer.

This layer is intentionally dumb: it does not call the model. Its job
is to prove "this event is from who it claims to be from" and to
dispatch to the runtime with a complete request envelope.

### 3. Agent runtime

The runtime is the heart of the system. For each incoming event it:

1. Acquires a **thread lock** (one runtime per logical conversation
   at a time). Follow-up messages while a run is active are queued.
2. Loads **conversation state** for the thread (messages so far,
   tools used, memory recalled).
3. Loads **scoped memory** relevant to the channel + user, with
   retrieval enforced at this layer.
4. Builds the **system prompt** using base instructions + channel
   policy + tone calibration + runtime context.
5. Builds the **toolset**: builtins + enabled skills + enabled MCPs
   for the (user, channel, team) triple.
6. Calls the model with streaming, dispatching tool calls in
   parallel where independent.
7. Persists the resulting conversation state and emits audit events.
8. Releases the thread lock; drains queued follow-ups.

The runtime is model-agnostic. It speaks an internal protocol that
adapts to Claude / GPT / Gemini via a thin provider layer.

#### Why a thread lock?

Pookie has this and it's correct: without a lock, two concurrent
messages in the same thread can produce interleaved replies, double
tool calls, and corrupted state. The lock makes the runtime
sequential per thread while remaining concurrent across threads. See
pookie's `thread-lock.ts` for the pattern we'll adopt.

#### Why streaming?

In a workspace context, time-to-first-token matters as much as total
latency. A response that starts in 800ms and finishes in 8s feels
faster than one that finishes in 5s with nothing visible until then.
Streaming also lets us flush long-form content in chunks the
platform can render.

### 4. Memory service

A scoped key-value + structured store. Three scope kinds at the data
layer:

- **personal**: `(org, user)`
- **project / channel**: `(org, channel)`
- **team**: `(org)`

Retrieval is enforced by the service, not the model. The runtime
passes a (org, user, channel) triple; the service returns the union
of personal-for-that-user, channel-for-that-channel, and team. Cross-
scope retrieval is impossible at the API boundary.

Memory entries are encrypted at rest and tagged with origin (who
created them) and TTL. See `03-memory-model.md`.

### 5. Skill / MCP registry

A read-mostly catalog that returns the list of executable skills for
a (team, channel, user) tuple. Each entry includes:

- Name, version, manifest URL.
- Required scopes (read channel, post message, network egress to
  `*.linear.app`).
- Approval status for this team.
- Execution surface (in-process skill / MCP server / hosted
  function).

The registry does not execute the skill; it tells the runtime *how*
to execute it. The dispatcher (in the runtime) wires up the actual
call.

See `04-skills-and-mcp.md`.

### 6. Task service

The Task service is the durable counterpart to the conversation
state. A task is a stateful object with:

- A spec (what to do).
- A status (pending, running, waiting, succeeded, failed,
  cancelled).
- A resumable continuation (a way for a worker to pick up where it
  left off).
- A schedule or trigger (cron, event hook, deadline).
- An owner (user + channel where it was created).
- An audit trail.

Tasks are not just cron jobs. They can wait on external events ("PR
1234 closed"), aggregate over time ("count daily error rate"), or run
multi-step plans with intermediate state.

See `05-tasks-async.md`.

### 7. Audit & observability

Every meaningful action emits a structured event:

- Memory read/write (with scope, origin, content hash).
- Tool call (with name, args summary, result summary, duration).
- Outbound message (with channel, summary).
- Skill execution (with version, approval).
- Memory partition crossings *attempted* (should always be zero —
  emit if non-zero).
- Cost (model tokens in/out, tool API costs).

The event stream feeds:

- **Real-time traces** for debugging (OpenTelemetry / Axiom).
- **Audit log** for admins, retained per policy.
- **Privacy receipts** attached to user-visible responses.
- **Cost dashboards** per team / channel / user.

See `09-observability.md`.

## Cross-cutting concerns

### Identity

Identity is the join key for everything: memory, tasks, cost
attribution, audit. The platform user ID is *not* the identity; the
organization identity is. Adapters carry a translation layer.

- On first contact from a new platform user, ingress creates or
  links to an existing org identity (email match, SSO claim).
- Once linked, the platform user is durably mapped.
- Identity is portable across platforms: the same org identity
  shared between Slack and Teams sees the same memory and tasks.

### Encryption

- All memory contents and stored conversation state are encrypted at
  rest with a per-team key (envelope encryption: per-team data key
  wrapped by a tenant master key).
- Self-hosted deployments can supply their own KMS root key (CMK).
- OAuth tokens for connected MCPs are encrypted with the same
  scheme.

### Caching

- Prompt prefix caching is a first-class design constraint. The
  prompt is assembled in **stable order**: base system prompt → team
  policy → channel policy → tone block → runtime context → static
  memory blocks → message history → injected reminders.
- The reminder is injected into the last user message only, and
  injection is idempotent so we don't double-wrap on follow-up
  rounds. Pookie does exactly this; we'll borrow it.

### Backpressure & rate limits

- Per-team request rate limit at ingress.
- Per-user per-minute soft limit.
- Per-channel budget envelope (admin-configurable).
- Tool call concurrency cap per run.
- Global model-provider rate limit handling with retry and queue
  shedding.

### Failure modes

- Model provider down → fallback provider (configurable per team).
- MCP server unreachable → mark stale, surface re-auth or error;
  don't block other tools.
- Memory store unreachable → degrade to no-memory mode with explicit
  user notice.
- Adapter disconnect → automatic reconnect with backoff; queue
  events.

The principle: degrade visibly, not silently.

## Deployment shape

### Hosted

- Multi-tenant SaaS.
- Stateless agent runtime workers, autoscaled.
- Stateful services (memory, task, registry, audit) hosted on a
  managed Postgres + Redis stack.
- Per-tenant data isolation enforced at the data layer (row-level
  security in Postgres, namespace keys in Redis).

### Self-hosted

- Same components, packaged via Docker Compose / Helm.
- Bring your own Postgres + Redis (or managed via the chart).
- Bring your own model provider API key.
- Optional: provide your own KMS for envelope encryption.

Pookie's "Vercel-only scheduling" gap is instructive. We will not
ship a feature that *only* works on hosted; self-host gets the same
core capabilities, even if the operator has to configure more. See
`05-tasks-async.md`.

## Decisions

- **Thread lock**: required, per-thread sequential runs.
- **Streaming**: required, time-to-first-token is a tier-1 metric.
- **Model-agnostic provider layer**: required from day one.
- **Identity = organization identity**, not platform identity.
- **Memory partitioning enforced at the retrieval layer**, not the
  prompt.
- **Audit events for every meaningful action**, with a defined
  schema.
- **Stable prompt-prefix order** for cache stability.
- **Self-host parity** for all core capabilities.

## Open questions

- Postgres vs. Postgres + vector store for memory retrieval. Likely
  Postgres + pgvector for v1; revisit if recall quality is a problem.
- Workflow engine for the Task service: build vs. adopt Temporal /
  Cadence / Inngest. Build for v1 (keeps the surface tight); revisit
  for v2 when task complexity grows.
- Multi-region: do we need it for v1? Probably no for hosted; yes for
  enterprise self-host (data residency).
- How aggressive is prompt caching across users? Cross-user prefix
  sharing improves cost but constrains personalization placement;
  worth a benchmark.
