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
| `pendingQuestions(threadId)` | Questions the worker agent asked | Never lists permission prompts |
| `answer(threadId, requestId, answers)` | Reply to a question | No retry key on T3; check `pendingQuestions` first |
| `send(threadId, text, mode, requestId)` | Steer or queue | Idempotent with `requestId` |
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

Facts below come from T3 Code at commit `42da166d`, rechecked at `771fd93f` (2026-10-19). Recheck
them when you upgrade T3.

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
| `findByTitle` | `t3_thread_list(titleContains)`, then a prefix match on `[J-<id>]` | Read |
| `launch` | `t3_thread_launch` with `workspaceStrategy: worktree` | Supervised+ |
| `wait` | `t3_thread_wait` (default 10 min, max 60 min; Sym uses 60 s, and the MCP request gets 15 s more) | Read |
| `readActivity`, `readMessages` | `t3_thread_read` (`view: activity` or `messages`, `afterPosition`) | Read |
| `pendingQuestions`, `answer` | `t3_pending_request_list`, `t3_pending_request_read`, `t3_pending_request_respond` | Read / Supervised+ |
| `send` | `t3_thread_send` (`mode: auto/queue/steer/restart`, `clientRequestId`) | Supervised+ |
| `interrupt` | `t3_thread_interrupt`, `t3_workflow_stop` | Supervised+ |
| `watchPullRequest` | `watch_pull_request` (it links the PR first). A wake shows in the worker thread as a `notification` item such as `#12: checks failed`; reconcile posts each once (decision 034) | Above read-only |
| `settle` | `t3_thread_organize(settle)` | Supervised+ |

Also available: queue tools, thread fork and merge-back, `t3_worktree_list`, T3-side schedules,
and attachments (10 MiB images, 50 MiB files) for passing Slack files into a thread.

### Connection and sign-in

- Transport: Streamable HTTP at `<origin>/mcp`. The T3 server listens on port 3773 by default.
- Use HTTPS off the worker host: enable Tailscale HTTPS in T3 (Settings, Connections) or run
  `t3 serve --tailscale-serve`, then use `https://<worker>.<tailnet>.ts.net/mcp`. The MCP client
  refuses to send a token request over plain HTTP except to loopback, so
  `http://<worker>.<tailnet>.ts.net:3773/mcp` answers but cannot complete the sign-in.
- T3 derives its OAuth issuer and endpoints from the request origin, and sends `iss` on the
  sign-in redirect (RFC 9207). Sign in through the same URL Sym uses later.
- Sign-in: OAuth 2.1 with discovery, dynamic client registration, and PKCE. Every client is
  public. Loopback redirect URIs match on everything but the port. The `resource` parameter must
  equal the MCP URL.
- The owner approves on T3's consent page (`/connect-agent`) with a signed-in browser or a
  pairing code, and picks the access level there.
- `t3 auth session issue --subject mcp-client` mints a token without OAuth, but its ceiling is at
  most Supervised. Sym needs the consent flow for Auto (decision 009).
- An outside client must pass `modelSelection` when the project has no default model. Sym
  passes `SYM_WORKER_MODEL` and first checks that `orchestrator_capabilities` offers it.
- Sym calls T3 from code through `lib/workers/t3/` (decision 015). Milestone 1 signs in with
  `pnpm t3:login <mcp-url>`, which saves the token to `.env.local`.

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
