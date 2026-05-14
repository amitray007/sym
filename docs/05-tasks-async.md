# 05 — Tasks (async, durable, resumable)

## Why this doc exists

A teammate that disappears between messages and only "remembers"
things via scheduled prompt re-runs is a tool, not a teammate. The
Task service is what turns Sym into something that *owns work over
time*.

This is the single biggest capability gap vs. pookie. Pookie's
scheduling is "fire this prompt on cron." Sym's Task service is
"orchestrate this multi-step work until done or cancelled, surface
status, recover from failures, audit every step."

## What counts as a task

Examples we want to support cleanly:

- **PR watcher**: "Ping me when PR 1234 merges or fails CI. Cancel
  in 7 days." Triggered by a poll or webhook. State: last seen
  status, attempts.
- **Recurring digest**: "Every weekday at 9am, summarize the last
  24h of #alerts into #leadership." State: last fire time, last
  summary content.
- **Outcome wait**: "When the production deploy finishes, run smoke
  tests and post results in #deploys. If smoke tests fail, page on-
  call." Multi-step with a branching outcome.
- **Cohort sweep**: "Once a week DM every channel admin who hasn't
  reviewed pending skill approvals." Multi-target with per-target
  state.
- **Long Q&A**: "Triage these 30 tickets one-by-one with me." Owned
  state across many human turns, not just one.
- **Reminder with context**: "Remind me about this next Monday." A
  task carrying the thread permalink + the surrounding context so
  the reminder is useful, not just "you said something."

These are all the same primitive: a stateful, externally-triggered
or schedule-triggered, multi-step process owned by Sym.

## Task model

```ts
interface Task {
  id: string;                          // ulid
  orgId: string;
  createdByUserId: string;
  channelId?: string;                  // where it lives
  threadId?: string;                   // optional originating thread
  spec: TaskSpec;                      // typed, see below
  status: TaskStatus;
  state: Record<string, unknown>;      // task-private state
  triggers: Trigger[];                 // schedule / webhook / event hook
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;                  // hard deadline
  history: TaskEvent[];                // append-only audit
  result?: TaskResult;
  cancellation?: { by: string; reason?: string; at: number };
}

type TaskStatus =
  | "pending"     // created, not yet scheduled
  | "scheduled"   // waiting for next trigger
  | "running"     // worker holding it
  | "waiting"     // waiting on an external event
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

type TaskSpec =
  | { kind: "cron_prompt"; cron: string; prompt: string; channel: string }
  | { kind: "pr_watch"; url: string; pingOn: "merge"|"close"|"both" }
  | { kind: "wait_then"; until: WaitCondition; then: TaskSpec }
  | { kind: "cohort"; members: string[]; perMember: TaskSpec }
  | { kind: "agent_loop"; prompt: string; budget: Budget; toolsScope: ToolsScope }
  // …
```

The spec is a *typed sum*. Each kind has a worker that knows how to
advance it. Adding a new kind is a code change, intentionally — it
enforces explicit thinking about side effects, idempotency, and
recovery.

### Why not just "agent loops everywhere"?

We could express everything as "give the agent this prompt and let
it figure out." Pookie's cron is roughly this. The problem at work
scale:

- An LLM agent loop is expensive and non-deterministic. For
  predictable tasks (watch a PR, post a digest), a typed worker is
  cheaper and more reliable.
- For complex/exploratory tasks, the `agent_loop` spec is the
  escape hatch.

Both layers exist. We default to typed workers; we fall through to
agent_loop only when no typed worker matches.

## Triggers

A task can be triggered by:

- **Schedule** (cron-like, with sub-minute support).
- **Webhook** (a specific URL with an HMAC secret).
- **Event hook** (an internal event like `pr_state_changed`, fed by
  poll workers or platform webhooks).
- **Resume after delay** (an internal continuation when a worker
  yields with "wake me at T").

Multiple triggers per task are allowed.

## Idempotency

Every trigger fire passes an `occurrence_key` (e.g.,
`taskId:occurrence_ms` or `taskId:webhook_message_id`). Workers
de-duplicate on this key. Pookie's queue layer does this too; we
follow the pattern.

## Workers

A worker:

1. Pulls a task fire from the queue.
2. Loads the task by id.
3. Runs one step of the spec (advancing the state).
4. Either: completes, errors, yields with a "wake me at T" or "wait
   for event E."

Yielding is how long waits avoid sitting in memory. A 30-day wait
for "is this PR merged?" doesn't hold a worker; it sleeps in the
store until a trigger fires.

### Resumability

State is persisted on every step. If a worker crashes mid-step, the
next worker reads the same state and retries from the last
checkpoint. Steps must be idempotent (skill SDK gives helpers).

### Failure budget

Tasks have a per-occurrence failure budget (e.g., 3 retries with
exponential backoff). On budget exhaustion the task transitions to
`failed` and posts a message to the originating user/channel.

## Hosted vs. self-hosted

Pookie's scheduling-is-Vercel-only gap is the cautionary tale. We
will not ship a task service that only works in one deploy target.

- **Hosted**: managed worker pool, durable queue (e.g., NATS JetStream
  or Postgres-backed queue or a managed offering).
- **Self-hosted**: the same worker binary, the same queue protocol;
  config points to a self-managed Postgres or Redis. We bundle a
  Postgres-backed queue implementation so the only required
  dependency is Postgres + the worker process.

Decision: **Postgres-backed queue for v1** for both. Reasons:

- Self-hosters already need Postgres for the rest of state.
- No second dependency to manage.
- Excellent durability + transactional ergonomics.
- Migration to a higher-throughput queue (Redis streams, JetStream,
  managed SQS-like) is straightforward later.

## Surfacing tasks to users

A task is invisible if you can't ask Sym about it. Builtins:

- `task_list`: "what are you tracking for me?" → lists tasks owned
  by the asker, status, next fire.
- `task_status <id|name>`: deep status with history excerpt.
- `task_cancel <id|name>`: confirms and cancels.
- `task_modify <id> …`: amend cron / extend expiration.

Tasks created in a channel are surfaced via a per-channel
`channel.pinned_tasks` view (optional Slack canvas or Teams tab).

### "Why did you do that?"

When Sym posts because a task fired, the message includes a
discreet receipt:

> *Posted by Sym's PR Watcher task • last fired 09:00 • next 09:00
> tomorrow • cancel*

A click on `cancel` cancels the task (with admin guards on shared
tasks).

## Authorization

- A user who created a task can cancel/modify it.
- A channel admin can cancel any task posting into their channel.
- A team admin can cancel any task in the org.
- Pookie chose to *not* give admins an override for personal cron
  tasks; we'll match for personal tasks but admins can always
  cancel tasks that post into channels they administer.

## Tasks as conversation context

A task may be the *speaker* in a thread. When Sym replies in a thread
*because of a task*, the conversation state knows this, and follow-up
human messages can interact with the task ("pause this for the rest
of the week").

```
[Sym, via PR Watcher task]: PR 1234 just merged 🎉
[Alice]: pause this until Monday
[Sym]: ✅ task paused, will resume Monday 9am
```

The agent loop here is short: it interprets the human message as a
task command and operates on the task object, not the conversation.

## Limits & budgets

- Max active tasks per user: configurable (default 50).
- Max active tasks per team: configurable (default 1000).
- Per-task token budget (when the spec includes LLM steps).
- Per-org cost cap; tasks that would exceed it are paused with a
  notification to admins.

## Decisions

- **Typed task specs** as the default; agent_loop as escape hatch.
- **Postgres-backed durable queue** for parity hosted/self-host.
- **Resumable, idempotent workers** with per-occurrence keys.
- **Tasks have audit, status, cancel, modify** as first-class
  operations.
- **Tasks can be speakers**; their messages carry receipts.
- **Cost & active-task budgets** enforced at the service.

## Open questions

- Web UI for task management vs. all-chat? Probably chat-first with
  a minimal admin web UI in v2.
- Per-task observability: do we expose a "task trace" to the
  creator? Yes for v2.
- Cross-platform task continuity: if Slack becomes unreachable, can
  a task post via email or Teams instead? Probably v2.
- "Skill builders building tasks" vs. "users scheduling tasks": same
  primitive, different surface. We expose both, with skill-built
  tasks being more powerful (private state, custom triggers).
