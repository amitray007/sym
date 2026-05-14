# 10 — v1 scope (MVP)

## What v1 is

The smallest version of Sym we can put in front of real teams and get
true signal on the "teammate not bot" thesis. v1 is opinionated, narrow,
and uncompromising on the trust pillars (memory partitioning, receipts,
audit). It is *aggressive about cutting features* that don't serve the
core thesis.

## What v1 is not

- It is not feature-parity with pookie.
- It is not Glean/Dust replacement.
- It is not multi-platform.
- It is not a public skill marketplace.

If a feature is not on this list, it's punted to v1.x or v2.

## Surface: Slack only

- Hosted multi-tenant.
- Self-host as a Docker Compose + helm chart, with full feature parity
  for core capabilities.
- One workspace = one Sym install.

## Identity

- OAuth install by a workspace admin.
- Slack user → org user resolution by email (no SSO required for v1).
- SCIM provisioning support: v1.x.

## Conversations

- @mention in any channel Sym is invited to.
- DM works without @mention.
- Thread replies follow the thread.
- One run per thread (thread lock); follow-ups queued.
- Streamed responses.
- Slack markdown / blocks for output.

## Memory

- Four scopes: personal, channel, project, team.
- Encryption at rest with org-level data key.
- Retrieval enforced at the service.
- Capture + receipt indicator on each write.
- `remember`, `recall`, `forget` tools.
- Hard caps per scope; score-based eviction.
- CI red-team test suite for scope leak.
- DSAR primitive: admin-initiated user-scope erasure.

Punted to v1.x:

- Cross-scope inference detection.
- Sensitivity tier auto-assignment by the model (v1 uses defaults +
  admin/user override).
- Vector recall: v1 uses recency + keyword; pgvector in v1.x.

## Skills & MCPs

- First-party skill catalog: ~10 curated skills (see below).
- Manifest-based skill packaging.
- Admin approval flow.
- Pinned versions per team.
- MCP support as a skill subtype.
- Lazy tool loading when toolset > 20.

First-party skills in v1:

1. **web** (search + fetch).
2. **code-interpreter** (sandboxed Python).
3. **image-gen** (workspace-attached image generation).
4. **slack-search** (Slack-side search with permission gating).
5. **github** (read repos, PRs, issues; comment with confirmation).
6. **linear** (read issues, projects; create with confirmation).
7. **calendar** (read availability; create with confirmation).
8. **digest** (compose channel digests on schedule).
9. **pr-watcher** (the canonical Task example).
10. **memory** (the built-in memory tools — counted as a skill for
    the manifest contract).

Public marketplace, custom MCP submission UI: v2.

## Tasks

- Typed task spec with `cron_prompt`, `pr_watch`, `digest`,
  `wait_then`, `agent_loop`.
- Postgres-backed durable queue.
- Resumable workers.
- `task_list`, `task_status`, `task_cancel`, `task_modify` builtins.
- Status surfacing with receipt footer on task-fired messages.
- Hard limits: 50 tasks/user, 1000/org.
- Per-task token budget.

Punted to v1.x:

- Webhook-triggered tasks (we have cron + event-poll only in v1).
- Task observability dashboard.
- Channel-pinned "active tasks" view.

## Tone & formality

- Workspace floor (`casual` / `neutral` / `formal`) set at install.
- Channel policy: admin-configurable; auto-suggested at install per
  recent channel content.
- Tone-rewrite pass with substance-diff guard.
- Personal tone preference stored in personal memory.

Punted to v1.x:

- Multi-language locale support.
- Per-channel emoji palette.
- Voice/persona customization.

## Permissions & privacy

- Platform-derived auth, including requester-access check on every
  retrieval.
- Envelope encryption with managed KMS (hosted) or BYO KMS root
  (self-host).
- Privacy receipts on every response.
- Audit log with hash chain.
- US region for hosted at launch; EU region in v1.x.

Punted to v1.x:

- Customer-managed keys for hosted.
- WORM-storage audit option.
- HIPAA BAA.

## Observability

- Single event stream → receipts, audit, traces.
- OpenTelemetry export.
- Admin audit-log UI (filter, export).
- Cost dashboard per org / channel / user.
- Budgets with per-org hard cap.

## Admin surface

- Slack App Home tab with admin controls:
  - Channel policy view + edit.
  - Skill catalog + approve / reject / pin.
  - Audit log view + export.
  - Budget configuration.
  - User management (deprovision).
- Web admin UI (read-mostly mirror of the same): v1.x.

## Model

- Default model: Claude (latest Anthropic) for hosted; configurable
  per-org.
- Self-host: bring your own provider key (Anthropic, OpenAI,
  Google).
- Prompt-prefix cache enabled by default.
- A lower-cost model (Haiku-tier) used for the tone-rewrite pass.

## Out of scope for v1

- Microsoft Teams adapter.
- Discord adapter.
- Voice/audio inputs.
- Image input beyond what the model natively supports.
- Custom MCP submission UI (manual config only).
- Public skill marketplace.
- Multi-region active-active.
- Mobile-specific surface (Slack mobile is fine; we don't ship a
  separate app).
- Per-customer fine-tuning.

## Success criteria

We will know v1 is working if, after 90 days of pilot use with five
real teams of varying size:

- **Retention**: ≥ 4 of 5 teams renewed past pilot.
- **Engagement**: median ≥ 30 messages/day per active team.
- **Trust signal**: zero confirmed cross-scope memory leaks.
- **Task usage**: ≥ 50% of teams have ≥ 3 active tasks at any time.
- **Receipt understanding**: in user interviews, ≥ 80% of users can
  correctly explain what the privacy receipt is for.
- **Cost**: median cost-per-team-month within target envelope (TBD).
- **Latency**: p95 time-to-first-token under 1.5s.
- **Operator load**: < 1 hr/week of human ops per pilot team.

If any of "trust signal" or "retention" falls short, we revisit the
thesis. The other metrics are tuning.

## Risks specifically to v1

- **Skill catalog is thin**. Mitigation: pick the right 10. The
  curation matters more than the count.
- **Memory recall quality with recency+keyword may be weak**.
  Mitigation: dedicated eval set; if recall@10 < 80% on the eval
  set, bring vector recall forward.
- **Slack rate limits** for high-activity teams. Mitigation: per-
  team rate buckets + burst handling.
- **Self-host install pain**. Mitigation: the helm chart and the
  Compose file are first-class deliverables, not afterthoughts.
- **Privacy receipts overwhelm low-stakes channels**. Mitigation:
  compact-by-default rendering; admin opt-in for always-expanded.

## Estimated build effort

Order of magnitude, not a Gantt:

- Ingress + Slack adapter: 2 weeks.
- Agent runtime + tool dispatch: 3 weeks.
- Memory service + scopes + recall: 3 weeks.
- Task service + Postgres queue + workers: 3 weeks.
- Skill registry + manifests + first-party skills: 3 weeks (parallel
  with above).
- Audit log + receipts + admin UI: 3 weeks.
- Tone layer + rewrite pass: 1.5 weeks.
- Privacy/permission gating + tests: 2 weeks.
- Hosted infra + KMS + region: 2 weeks.
- Polishing, eval, dogfood, security review: 4 weeks.

Calendar with two engineers: ~5 months. With four: ~3 months.

## Decisions

- **Slack only.** No multi-platform until v1 is real.
- **Four scopes**; project scope ships in v1.
- **Postgres queue** for tasks; portable.
- **Manifest-based skills**; curated first-party catalog of ~10.
- **Hard limits and budgets** from day one.
- **Receipts on every response.**
- **Self-host parity** for core capabilities.

## Open questions

- Pricing for v1 pilots: free, paid, or paid-after-pilot? Strongly
  affects engagement signal interpretation.
- Default model — Claude vs. GPT — operationally one is easier
  cache-wise; both work.
- Initial channel-policy default for a freshly installed Sym:
  `neutral` floor with no per-channel overrides until admin
  configures? Or auto-classify everything at install? Probably the
  former for predictability.
