# 09 — Observability & audit

## What this doc covers

Three audiences read three views of the same underlying data:

1. **Users** see a *privacy receipt* attached to each Sym response.
2. **Admins** see an *audit log* of actions, with filters and export.
3. **Operators** see *traces* and *metrics* for debugging and
   capacity planning.

All three are projections over a single structured event stream. We
do not maintain three separate pipelines.

## The event stream

Every meaningful action emits a structured event:

```ts
interface Event {
  id: string;                    // ulid
  ts: number;                    // ms epoch
  orgId: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  actor: Actor;                  // who / what triggered this
  action: string;                // e.g. "memory.read", "tool.call", "chat.post"
  resource?: Resource;           // what was acted on
  result: "ok" | "denied" | "error";
  attributes: Record<string, AttrValue>;  // action-specific
  redactedFields?: string[];     // names of fields with redacted values
}

type Actor =
  | { kind: "user"; orgUserId: string; platformUserId: string; platform: string }
  | { kind: "agent"; runtime: "agent_runtime"; threadId: string }
  | { kind: "task"; taskId: string }
  | { kind: "skill"; skillName: string; version: string }
  | { kind: "admin_api"; orgUserId: string };
```

This is the canonical event. Every other view derives from it.

## Event catalog (initial)

Stable action names — admins will write rules against these.

### Conversation

- `message.received` — inbound message hit the agent.
- `message.skipped` — message in a channel Sym isn't @-mentioned in
  (and policy says ignore).
- `chat.post` — outbound message.
- `chat.react` — emoji reaction.
- `chat.canvas_post` — long-form output.
- `chat.edit` — edit of previous Sym message (e.g., correction).
- `thread.lock_acquired` / `thread.lock_released`.

### Memory

- `memory.read` — recall fetch, with scope and entry count.
- `memory.write` — capture, with scope and content hash.
- `memory.update` / `memory.supersede`.
- `memory.forget` — explicit deletion.
- `memory.cross_scope_denied` — should always be zero; non-zero
  triggers high-pri alert.

### Tools / skills

- `tool.call` — model-issued tool call (builtin or skill).
- `tool.result` — tool returned.
- `tool.denied` — capability gate rejected.
- `skill.invoke` — skill called (action wrapper).
- `mcp.call` — outbound MCP call (with server name).
- `mcp.error`.

### Tasks

- `task.create` / `task.cancel` / `task.modify`.
- `task.fire` — trigger fired.
- `task.step` — worker advanced state.
- `task.complete` / `task.fail` / `task.expire`.

### Admin

- `admin.skill.approve` / `.reject` / `.suspend`.
- `admin.policy.change` (channel policy, tone floor, retention).
- `admin.user.deprovision`.
- `admin.export` — data export.

### System

- `model.call` — outbound LLM call (provider, model, tokens in/out,
  cache hit info, latency).
- `model.error`.
- `auth.platform_user_resolved`.
- `rate_limit.shed` — request dropped due to budget.
- `egress.allowed` / `egress.denied`.

## Privacy receipts (user view)

A receipt is a compact, user-readable footer attached to each Sym
response. Derived from the events emitted during that turn.

Default form, ~one line:

> *Used: 2 channel memories • 1 web page • Linear (PAY-481).
> [details]*

Expanded form (the user taps "details"):

```
For this answer Sym used:
- 2 memories from #payments (channel scope)
- 1 web page: https://stripe.com/docs/disputes
- Linear issue PAY-481 (via Linear MCP)
- 0 personal memories
- 0 cross-channel content

Tools: web_fetch, mcp:linear.get_issue
Model: claude-sonnet-4-6 (1,200 in / 480 out tokens)
```

The expanded form is opt-in by default; admins can require it in
certain channels.

### Why receipts matter

- A user can verify the response wasn't fabricated.
- A user can verify their personal memory was (or wasn't) used.
- A user can verify nothing inappropriate leaked from another
  channel.
- The receipt sets the cultural expectation that *the bot shows its
  work*.

No other workspace assistant ships this prominently. It's a real
differentiator.

## Audit log (admin view)

An admin-facing view that queries the event stream by org, with:

- Filters: actor, action, channel, user, date range, result.
- Search: free-text against attributes.
- Export: CSV / JSON for SOC 2 / GDPR responses.
- Alerts: rules that fire on patterns (e.g., `memory.cross_scope_denied
  count > 0`).

### Retention

- Default: 1 year, configurable up to 7 years.
- Append-only with per-event SHA-256 hash chain (each event hash
  includes the previous event's hash). Tamper-evident at minimum.
- v2: WORM-storage adapter (S3 Object Lock or equivalent) for
  regulated industries.

### Sensitive fields

- Memory content: hashed in the event; the audit log shows
  "content_hash" not raw content. Admins with elevated permission
  and an explicit reason can retrieve raw content (with audit of
  the retrieval).
- Tool args/results: summarized by default; full payloads stored
  but require an admin to expand them (also audited).
- Secrets: redacted at the redactor step in ingestion. Tested.

## Operator view (tracing)

Standard distributed tracing:

- OpenTelemetry-compatible exports (OTLP).
- Default integrations: Axiom (pookie's choice), Datadog, Honeycomb,
  Grafana Tempo, Jaeger.
- Each turn is a trace; tool calls are spans; model calls are
  spans.
- Sampled by default in production (1% baseline + always-on for
  errors and for opted-in debug channels).

The `tracesFooter` debug-channel pattern from pookie is a great
operator UX. We adopt it: in `#sym-debug` or similar, every response
gets a tiny trace link footer.

## Metrics

Tier-1 metrics (SLOs):

- p50 / p95 time-to-first-token.
- p50 / p95 total response latency.
- Tool-call latency by tool name.
- Memory recall latency.
- Cost per turn (USD).
- Error rate by component.

Tier-2 (for capacity planning):

- Tasks running / waiting / failed.
- MCP server health (per server, per org).
- Adapter reconnect rate.

## Cost attribution

Every `model.call` and `tool.call` carries cost attributes. Roll-up
views:

- Per org.
- Per channel.
- Per user.
- Per task.
- Per skill.

Visible in the admin UI with daily / monthly trends.

### Budgets

Admins set:

- Per-org monthly cap (hard limit; over-cap = degraded mode).
- Per-channel monthly soft cap (warning + admin alert).
- Per-task hard limit (task pauses if exceeded).
- Per-skill cost rules (e.g., "Exa search costs are billed to the
  invoking channel, not the global org bucket").

## Explainability primitives

A user can ask "why did you do that?" as a follow-up to any Sym
response. The agent has access to the events from that turn (its
own trace) and can summarize:

> I posted because the PR Watcher task you created last Tuesday
> fired when PR 1234 closed. I used the Linear MCP to fetch the
> linked issue PAY-481 for context. No memory was used.

This is not an audit log dump; it's a short, plain-language summary
generated from the trace.

## Decisions

- **Single event stream**, three views (receipts, audit, traces).
- **Stable action vocabulary** so rules and alerts survive code
  changes.
- **Per-event hash chain** for tamper-evidence; WORM storage at
  v2.
- **Privacy receipts on every response**, default compact, expand
  on tap.
- **OpenTelemetry-compatible** export from day one.
- **Cost attribution per (org, channel, user, task, skill)**.

## Open questions

- Should receipts be visible to *all* readers of a message or only
  to the original asker? Probably all readers — transparency is the
  feature. But some sensitive channels may want it limited.
- How verbose is "explain why" by default? Probably terse;
  expandable.
- Streaming receipts: do we render the receipt incrementally as
  tools resolve, or only at the end? End is simpler and probably
  enough; streaming is a stretch goal.
- Long-tail action names: we let skills declare custom actions in
  their manifest. Worth standardizing now or letting it grow
  organically? Standardize the *kinds* (read/write/external),
  let skills name the specifics.
