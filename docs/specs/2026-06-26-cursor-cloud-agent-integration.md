# Spec — Cursor Cloud Agent integration

Status: draft for review
Date: 2026-06-26
Owner: Amit Ray

## Goal

Add a second execution tier to Sym: alongside the existing conversational Pi
loop, give Sym the ability to **dispatch autonomous coding tasks to Cursor
Cloud Agents** (isolated VMs that clone a repo, do the work, and open a PR) and
report progress + results back into the Slack thread.

This is **additive**. The conversational tier is unchanged.

## Non-goals

- Replacing the Pi loop / changing the conversational model (Fireworks stays).
- Local execution, local sandboxing, or running arbitrary infra CLIs
  (`gcloud`, etc.) — we use Cursor's default cloud environment, which does code
  / repo / PR work but does not carry your infra tooling.
- Credential injection (`envVars`) and custom Docker environments — left as
  clean future hooks, not built now.
- Live token-level streaming of the cloud run (Cursor only pushes terminal
  webhooks; we poll instead — see Lifecycle).

## Validated facts (spikes performed)

- The Cursor API key runs **Composer 2.5 headless with tool use** — confirmed
  via both the `cursor-agent` CLI (wrote a file) and `@cursor/sdk`
  `customTools` (tool invoked with correct args). The "API keys can't bill
  Composer" gate is **not** in effect for this account.
- `@cursor/sdk` exposes cloud agents via `Agent.create({ cloud: { repos, … } })`
  with `getRun()` / `cancelRun()` and `Run.status: running|finished|error`.
- **Webhooks are REST-only and not in the SDK's typed surface.** With the SDK,
  run tracking is by polling `getRun` until terminal.

## Architecture

Two tiers, mirroring Sym's existing conversational / control split.

```
Slack turn
   │
   ▼
Tier 1 — Conversational (existing Pi loop, unchanged)
   • chat + Sym builtin tools (slack / web / planning)
   • new builtin tool: dispatch_cloud_agent({ repo, task, branch? })
   │
   ▼  dispatch + track
Tier 2 — Cursor Cloud Agents (@cursor/sdk, isolated VMs)
   • Agent.create({ cloud: { repos, autoCreatePR } }, model: CURSOR_MODEL)
   • Cursor default environment + GitHub integration
   • runs autonomously → merge-ready PR
```

## New package — `@sym/cursor-runtime`

Mirrors `@sym/mcp-runtime`. Sits at the same DAG level; depends only on
`@sym/contracts` and `@cursor/sdk`. `@sym/agent` depends on it. `packages/*`
never import from `apps/*` (CI-enforced).

```
packages/cursor-runtime/
  src/
    client.ts       CursorCloudClient: dispatch() / getRun() / cancel()
    types.ts        CloudDispatchInput, CloudRunRecord, CloudRunStatus + Zod
    store.ts        CloudRunStore: SQLite active_cloud_runs
    reconciler.ts   CloudRunReconciler: poll active runs, emit transitions
    allowlist.ts    repo allowlist resolution
    index.ts        barrel
```

### `client.ts`
Thin wrapper over `@cursor/sdk`:
- `dispatch(input: CloudDispatchInput): Promise<{ agentId, runId }>` —
  `Agent.create({ apiKey, model: { id: CURSOR_MODEL }, cloud: { repos:
  [{ url }], autoCreatePR: true, skipReviewerRequest: false } })`, sends the
  task prompt, returns the durable agent id + initial run id.
- `getRun(agentId, runId): Promise<CloudRunRecord>` — maps SDK run status +
  result (PR url, summary, branch) onto our record.
- `cancel(agentId, runId): Promise<void>`.

### `store.ts`
SQLite-backed `active_cloud_runs` table: `runId ↔ { agentId, channel,
threadTs, taskCardTs, status, createdAt }`. Unencrypted (non-secret routing
data, same posture as `settings.db`). Defaults to `.sym/`, relocates to
`/data` in prod via env (same as the existing stores). This is **control-tier
state** (invariant I-2), not message state — I-1 is preserved.

### `reconciler.ts`
`CloudRunReconciler.start(onTransition)` — interval poller (default 10 s):
loads non-terminal rows, calls `client.getRun`, and on a status change invokes
`onTransition(record)`. Stops polling a run once terminal. Bounded concurrency.

### `allowlist.ts`
`resolveRepo(query, allowlist): RepoRef | null` — match a user-supplied repo
reference against the configured allowlist; reject unknown repos.

## `apps/agent` wiring (kept thin)

- `tools/cloud-agent.ts` — `dispatch_cloud_agent` descriptor + handler:
  validate args, resolve repo via allowlist, `client.dispatch`, persist to
  `CloudRunStore`, post the initial task card ("🚀 started on <repo>"), return
  a handle to the conversational model. Registered in `tools/registry.ts` and
  `ALL_BUILTIN_DESCRIPTORS`.
- boot (`server.ts`): construct `CursorCloudClient` + `CloudRunStore`, start
  `CloudRunReconciler`. On transition → update the task card; on terminal →
  post "✅ PR ready: <prUrl> — <summary>" (or the error) into the thread via
  the Slack client.
- `config.ts`: `CURSOR_API_KEY` (required when the feature is enabled),
  `CURSOR_MODEL` (default `composer-2.5`, optional params validated against
  `Cursor.models.list()` at boot), `CURSOR_REPO_ALLOWLIST`, poll interval,
  store path. Feature is opt-in: absent `CURSOR_API_KEY` → tool not registered,
  reconciler not started, zero behavior change.

## Lifecycle (async vs. statelessness)

1. Owner asks for code work → Tier-1 model calls `dispatch_cloud_agent`.
2. Handler dispatches, writes `active_cloud_runs`, posts initial card.
3. `CloudRunReconciler` polls `getRun` until terminal.
4. Terminal → post PR/summary (or error) to the thread; mark row done.

No message persistence; the run-tracking row is transient control-tier state
and is the only thing that survives the turn. A restart resumes polling from
the store (the reconciler reloads non-terminal rows at boot).

## Security posture

- Execution + any credentials live in Cursor's **ephemeral isolated VM**, never
  Sym's host.
- `autoCreatePR: true`, `skipReviewerRequest: false` → propose, human reviews
  and merges. No auto-merge.
- Owner-gate + `slack-guard` still front Tier 1, so only the owner can trigger a
  dispatch.
- Repo allowlist bounds what can be touched.

## Decisions (delegated, recorded)

1. Tier-1 model unchanged (Pi/Fireworks); cloud capability additive.
2. Dispatch via `@cursor/sdk` cloud mode; track via polling (`getRun`).
3. Repo resolution via control-tier allowlist.
4. Cursor default environment; no custom Docker, no `envVars` creds → code/PR
   work only (no `gcloud`/infra ops in scope).

## Open questions for review

- Default poll interval (proposed 10 s) and max concurrent tracked runs.
- Allowlist source: env var vs the existing `.sym/config.json` connector-style
  config file.
- Task-card granularity: terminal-only (simplest) vs. optional periodic status
  lines from polling.

## Phased implementation

1. Package scaffold + `client.ts` + `types.ts` (+ unit tests against a faked
   SDK).
2. `store.ts` + `reconciler.ts` (+ tests).
3. `apps/agent` wiring: tool, config, boot, task-card delivery.
4. End-to-end dispatch against a real repo from Slack; iterate on card UX.
