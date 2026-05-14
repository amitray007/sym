# 14 — Roadmap

## How to read this doc

Five phases. Each phase has:

- **Goal**: the single sentence describing what's true at the end.
- **What ships**: a tight list, not a wishlist.
- **What we learn**: the evidence we collect before moving on.
- **What punts to the next phase.**

Phase boundaries are *evidence gates*, not calendar gates. We don't
move to phase N+1 because three months passed; we move when N's
"what we learn" gates close.

Order of magnitude calendar (two engineers, then four) included for
planning purposes.

## Phase 0 — Prototype (4 weeks)

**Goal**: A working agent in one Slack workspace, ours, with the
runtime + adapters + memory + a couple of skills wired up.

**What ships**:
- Slack adapter (events, postMessage, threads).
- Agent runtime with thread lock, streaming, model-agnostic
  provider layer.
- Memory service with personal + channel scopes (no project / team
  yet).
- Two builtin skills: web search, slack search.
- One MCP wired up (GitHub) for demo purposes.
- Trace via OpenTelemetry to a hosted backend.

**What we learn**:
- Can the runtime + adapter shape carry the load?
- Where does prompt assembly need to be tighter?
- Do we hit Slack rate limits in single-workspace use?

**Punts**: tasks, tone, governance, multi-tenant, project scope,
admin UI.

## Phase 1 — Alpha (8-10 weeks)

**Goal**: Five friendly external teams using Sym daily; the trust
pillars are in place; we're brave enough to let people send
sensitive content to it.

**What ships**:
- Multi-tenant infra (Postgres RLS, per-org data keys, KMS).
- Project scope + team scope memory.
- Privacy receipts on every response, compact form.
- Audit log with hash chain.
- Slack App Home admin tab: channel policy, skill catalog (view-
  only).
- Tone calibration with workspace floor + per-channel overrides.
- Skill registry with manifests; ~5 first-party skills.
- Task service v0: cron prompts, basic typed specs, Postgres queue.
- Cost dashboard per org (read-only at this phase).
- SCIM-light: deprovisioning via Slack admin removal.

**What we learn**:
- Does the receipt land as a trust feature, or get ignored?
- Are scopes intuitive to users, or do we have to explain?
- What kinds of tasks do real teams create?
- What's our actual cost per active team?

**Punts**: Teams adapter, Discord, public marketplace, customer-
managed keys, WORM audit, vector recall.

## Phase 2 — Beta (10-14 weeks)

**Goal**: 25-50 teams; the loop economics work; we've shipped one
non-Slack adapter; the platform is stable enough that operator
load is sublinear in customer count.

**What ships**:
- Teams adapter (full feature parity for tier-1 capabilities).
- Vector recall (pgvector) with hybrid retrieval.
- Full task service: webhook triggers, event hooks, cohort tasks,
  agent_loop fallback.
- Public-facing admin web UI (mirror of Slack home tab).
- Skill SDK for third-party authors; first internal team-authored
  skills.
- EU region for hosted.
- Self-host packaging: docker-compose + Helm chart; reference
  install.
- Cost budgets enforced.
- Customer-visible "explain why you did that" follow-up.

**What we learn**:
- Does Teams adoption follow Slack?
- Do third-party / internal skill authors actually emerge?
- Self-host: hosted-vs-self-host ratio?
- Cost economics with vector recall.

**Punts**: Discord (stretch goal in this phase), marketplace listings,
SOC 2 audit (in progress, not certified).

## Phase 3 — GA (calendar TBD)

**Goal**: Sym is a real, paid product. SOC 2 Type II. Enterprise
customers. Multi-platform across Slack + Teams + Discord. Trust
posture is independently verifiable.

**What ships**:
- Discord adapter.
- SOC 2 Type II certification.
- Customer-managed encryption keys (BYOK).
- WORM-storage audit option.
- HIPAA-ready posture with BAA available.
- SCIM full integration; SSO across major IdPs.
- Marketplace catalog with rated, reviewed skills.
- Multi-region active for hosted.
- Open-source release of the runtime, adapters, skill SDK, first-
  party skills (proprietary: admin tools, enterprise add-ons).
- Public docs, case studies.

**What we learn**:
- Enterprise sales motion's friction points.
- Marketplace dynamics: are good third-party skills emerging?
- Where do we lose deals?

**Punts**: Industry-vertical SKUs, dedicated tenancy, FedRAMP.

## Phase 4 — Platform (open-ended)

**Goal**: Sym is a platform for workspace agents. Other companies'
products *are built on top of* Sym.

**What ships**:
- Multi-agent orchestration: multiple specialized "Syms" working
  together in one workspace.
- Dedicated tenancy options.
- Voice / mobile / email surfaces.
- Industry-vertical SKUs.
- Marketplace economy (third-party skill authors get paid).
- Federation: cross-organization Sym interactions in shared
  channels.
- Workflow editor: a no-code surface for non-developer admins to
  author lightweight skills.

**What we learn**: TBD. By this phase the market shape is teaching
us, not the other way around.

## Cross-cutting tracks

These run in parallel with all phases:

### Evals

- Hold-out conversations with golden responses, per category
  (search, action, memory recall, refusal).
- Continuous evaluation against the latest model snapshots.
- Red-team suite for scope leak + prompt injection (CI-gated).
- Tone-rewrite regression suite (substance preservation).

### Security

- Annual penetration test from Phase 1 onward.
- Bug bounty program from Phase 2.
- Internal red team running scenarios from Phase 2.

### Performance

- p95 TTFT < 1.5s target by Phase 1; hold it through Phase 3.
- Per-tool latency budgets enforced.
- Quarterly load tests.

### Docs & DX

- Docs site live by Phase 1.
- Skill SDK docs + examples by Phase 2.
- Operator docs (self-host) by Phase 2.

### Community

- Closed alpha → invited beta → open beta over Phase 1-2.
- Discord / Slack community from Phase 1.
- Open source release in Phase 3.

## Evidence we'd look for to NOT proceed

Honest version of "what would make us pivot":

- Phase 0 → 1: if the basic agent loop in a single workspace is
  generating consistent low-quality output we can't fix with
  prompts, this is a model-or-product-fit problem. Pause, re-cut.
- Phase 1 → 2: if pilot teams aren't *renewing* (regardless of
  metrics), the value prop isn't landing. Pause, interview deeply.
- Phase 2 → 3: if Teams adoption is 5x harder than Slack (more
  than just adapter work), the multi-platform thesis is in trouble.
  Pause, decide whether to remain Slack-first.
- Phase 3 → 4: enterprise sales motion is the gating function here.
  If it's a slog, we lean back into self-serve.

## Decisions

- **Evidence gates, not calendar gates.**
- **Project scope ships in Phase 1**, not later (it's a v1 must).
- **Teams adapter is Phase 2**, not Phase 3 — multi-platform is
  central enough to not be a v3 problem.
- **Open-source release is Phase 3**, not Phase 1 — we want the
  product to be opinionated before letting it ossify in OSS.
- **SOC 2 is Phase 3**, with the controls work starting in Phase 1.

## Open questions

- Pricing experiments: when and how. Probably mid Phase 1.
- Hire profile: when do we add a second engineer, designer,
  security person? Roughly: end of Phase 0, mid Phase 1, mid Phase 2.
- Investor / funding timeline: not addressed in this doc; out of
  scope.
- When do we name the product, if "Sym" isn't the final name?
  Likely Phase 1 — alpha customers care, beta customers gossip,
  GA customers expect a final name.
