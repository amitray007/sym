# Workers

A worker runs agent threads that do the real work in repositories. Sym reaches each worker through
an adapter. The first adapter drives T3 Code. Other adapters can follow without changes to the job
ledger, the watch loop, or the display rule.

## Adapter contract

Every adapter implements the same operations. The `t3_job` tool and reconcile call only these.

| Operation | Purpose | Notes |
|---|---|---|
| `capabilities()` | Providers, models, and limits the worker offers | Called before each launch |
| `projects()` | Projects the worker knows, with IDs | The pack maps project names to IDs |
| `findByTitle(jobId)` | Find a thread for a job | Guards against a duplicate launch |
| `launch(brief)` | Start a thread in a new worktree | No retry key on T3, so `findByTitle` runs first |
| `wait(threadId, timeout)` | Block until a status change or timeout | Keep timeouts short so HTTP calls do not time out |
| `readActivity(threadId, cursor)` | New activity since the cursor | The cursor lives on the ledger row |
| `readMessages(threadId)` | Final messages, for the output contract | |
| `pendingQuestion(threadId)` | A question the worker agent asked | Returns nothing for permission prompts |
| `answer(threadId, requestId, answer)` | Reply to that question | |
| `send(threadId, text, mode, requestId)` | Steer, queue, or restart | Idempotent with `requestId` |
| `interrupt(threadId)` | Stop the thread | Safe to retry |
| `watchPullRequest(threadId, url)` | Let the worker react to CI and reviews | Optional |
| `settle(threadId)` | Tidy a finished thread | Optional |
| `health()` | Reachable, signed in, sign-in expiry | Used by reconcile |

Status values that every adapter maps to: `running`, `waiting`, `completed`, `failed`,
`interrupted`, `unknown`.

## T3 Code adapter

[T3 Code](https://github.com/pingdotgg/t3code) runs Claude Code and Codex threads on the worker
host. Its server exposes a remote MCP endpoint at `/mcp` with OAuth. Sym connects as an outside
OAuth client. Outside clients get the orchestration, worktree, and pull request tools. They never
get preview or device tools, or tools that act as the calling thread.

Facts below come from T3 Code at commit `42da166d`. Recheck them when you upgrade T3.

### Access levels

The owner picks a level once, when approving Sym's sign-in. It caps every thread Sym starts.

| Level | Can do | Thread mode ceiling | Use |
|---|---|---|---|
| Read only | List, read, wait | Cannot start threads | Monitoring only |
| Supervised | Start and steer threads | Every permission prompt blocks | Jobs the owner watches live |
| Auto-accept edits | Same | Edits approved, other prompts block | Code jobs with few shell commands |
| Auto | Same | Agent auto mode, fewer prompts | Default (decision 009) |
| Full access | All, plus project create and delete | No prompts | Unattended jobs that must never block. A leaked token can do anything T3 can |

Permission prompts cannot be approved over MCP. A thread below Full access that hits a prompt
waits until a person approves it in the T3 app. Sym can only tell the owner.

### Tool map

| Adapter operation | T3 tool | Level |
|---|---|---|
| `capabilities` | `orchestrator_capabilities` | Read |
| `projects` | `t3_project_list`, `t3_project_read` | Read |
| `findByTitle` | `t3_thread_list(titleContains)` | Read |
| `launch` | `t3_thread_launch` with `workspaceStrategy: worktree` | Supervised+ |
| `wait` | `t3_thread_wait` (default 10 min, max 60 min; Sym uses 1 to 5 min) | Read |
| `readActivity`, `readMessages` | `t3_thread_read` (`view: activity` or `messages`, `afterPosition`) | Read |
| `pendingQuestion`, `answer` | `t3_pending_request_list`, `t3_pending_request_respond` | Read / Supervised+ |
| `send` | `t3_thread_send` (`mode: auto/queue/steer/restart`, `clientRequestId`) | Supervised+ |
| `interrupt` | `t3_thread_interrupt`, `t3_workflow_stop` | Supervised+ |
| `watchPullRequest` | `link_pull_request`, `watch_pull_request` | Supervised+ |
| `settle` | `t3_thread_organize(settle)` | Supervised+ |

Also available: queue tools, thread fork and merge-back, `t3_worktree_list`, T3-side schedules,
and attachments (10 MiB images, 50 MiB files) for passing Slack files into a thread.

### Limits

- T3 does not push events to outside clients. Sym polls, and the brief asks the worker agent to
  POST its result to an Eve webhook URL. Polling stays as the fallback.
- No refresh token. The sign-in lasts 30 days, then the owner re-approves.
- `t3-thread://` links open only in the T3 app. Slack shows the thread ID as text.
- The macOS T3 service stops when the user logs out. The Linux systemd service survives logout.
- `t3_thread_launch` and `t3_pending_request_respond` have no retry key.
- Outside clients cannot use `delegate_task`, `request_secret`, `create_threads`, previews,
  devices, or `html_render`.

### Repository guardrails

Before each launch, Sym puts the job's limits in the brief: allowed projects and paths, branch
strategy (a new worktree for code changes), whether to push or open a PR, and read-only access to
production and customer data. The worker thread also inherits the repository's own agent settings
and any environment the worker host applies to that folder.

## Adding an adapter

1. Implement the contract in `workers/<name>/`.
2. Map the worker's states to the shared status values.
3. Add a fake for tests. Tests never call a real worker.
4. Record the adapter's limits in this document and its choice in a decision.
