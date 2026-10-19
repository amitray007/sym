# Architecture

## Components

```
            Slack (public HTTPS)                         Worker host (private network)
                 │                                        ┌───────────────────────────┐
                 ▼                                        │ T3 Code service           │
 ┌──────────────────────────────────────┐   MCP / OAuth   │  /mcp  thread tools       │
 │ Sym: Eve app (Node 24, one replica)  │ ──────────────▶ │  Claude Code / Codex      │
 │  channels/slack.ts   talk, buttons   │                 │  threads in your repos    │
 │  channels/mcp.ts     workers call in │ ◀────────────── │                           │
 │  tools/t3_job.ts     one job = task  │  callback URL   └───────────────────────────┘
 │  schedules/dispatch  owner schedules │
 │  schedules/reconcile safety net      │        Postgres
 │  hooks/ledger.ts     event log       │ ───▶  jobs, schedules, outbox,
 │  lib/display.ts      display rule    │        feedback, memory, playbooks
 └──────────────────────────────────────┘
```

| Part | Role |
|---|---|
| Eve app | Brain. Slack channel, tools, workflow tasks, approvals, schedules, memory |
| Worker adapter | Starts, watches, steers, and stops worker threads. T3 Code first ([workers.md](workers.md)) |
| Postgres | Job ledger, schedules, outbox, feedback, memory, approved playbooks |
| Reconcile | Compares the ledger with each worker every 3 minutes and repairs drift |
| Dispatch | Fires due schedule rows every minute, with a lease per row |
| Outbox | Durable Slack posts with an idempotency key per post |

Only the Slack route is public. The MCP channel, the HTTP channel, and the worker stay on a
private network such as a tailnet ([self-hosting.md](self-hosting.md)).

## The job ledger

The ledger is the source of truth. Eve sessions and tasks are not. A self-hosted Eve upgrade
strands running sessions, so every job keeps enough state to continue in a new session.

| Table | Holds |
|---|---|
| `jobs` | ID, kind, Slack channel and thread, brief, worker and thread ID, status, cursor, last summary, job card `ts`, display choice |
| `schedules` | Cron (UTC), stored brief, approval state, trust level, lease |
| `outbox` | Pending Slack posts with an idempotency key |
| `feedback` | Buttons, reactions, "Fix" replies, brief edits, linked to a job |
| `memory` | Facts and preferences (learning layer 1) |
| `playbooks` | Approved playbooks and rules with version history (learning layer 2) |

Job statuses: `launching`, `running`, `waiting_input`, `waiting_permission`, `quiet`,
`worker_offline`, `checking`, `done`, `failed`, `cancelled`.

## Flow 1: someone asks for work

Example: "@sym add retry with backoff to the billing sync in sync-service, open a draft PR".

1. `onAppMention` checks the sender against the allow-list and starts a session for the thread.
2. The model loads the `task-brief` playbook and writes a brief: project, goal, constraints, a
   done-when list, and an output contract. The contract is a final JSON block with `summary`,
   `pr_url`, `tests`, `files_changed`, and `open_questions`.
3. Code changes need approval. Sym posts the brief with Start, Edit, and Cancel buttons.
4. After Start, `t3_job` runs as an Eve task, so the conversation stays open:
   - It writes a `jobs` row with status `launching`.
   - It looks for a worker thread whose title holds the job ID. If one exists, it adopts it. This
     stops a re-run step from launching twice.
   - It launches the thread: title `[J-142] Billing sync retry`, a new worktree, the model the
     worker reports, runtime mode `auto`. The message is the brief, the output contract, and the
     callback URL.
   - It saves the thread ID and posts the job card when the display rule picks level 3.
5. The watch loop runs until the thread ends.
6. Sym checks the result and posts the outcome in the thread.

## Flow 2: a schedule fires

Example: "Every weekday at 09:00, run the on-call check and tell me only what needs attention."

1. The owner says it once. Sym calls `schedule_create`, which needs approval. Sym shows the row:
   cron in UTC, project, brief, runtime mode, read-only. That approval covers every fire.
2. Every minute, `dispatch` claims due rows with a lease, so a row cannot fire twice.
3. For each due row, `dispatch` opens a new Slack thread with `to(slack, { channelId })`. The
   session has a real channel, so buttons and the job card work.
4. The model calls `t3_job` with the stored brief. The approval policy skips the click for rows
   that are already approved.
5. When the check finds nothing, the model calls `no_reply`. Nothing posts, and the evening digest
   lists "On-call check: all clear".

Sym owns schedules instead of the worker (decision 008). Sym then knows each run before it starts,
so it can open the thread, record the job, and pick the display level.

## Flow 3: watching a running job

```
loop:
  race(callback webhook, sleep 4 min)
  worker.wait(threadId, 60 s)            -> status, timedOut
  worker.readActivity(threadId, cursor)  -> new items, next cursor
  if status == waiting:
      worker.pendingQuestion() -> question? -> ctx.ask in Slack -> worker.answer()
                               -> none?     -> permission prompt -> tell the owner to approve on the worker
  update the job card (chat.update), yield a short status line
  if material change:            post (through chooseDisplay)
  if no new activity for 20 min: mark the card "quiet"; post once
  if terminal: break
```

A short rule set in the `progress` playbook decides "material change", not a model call per loop.
Only these post a new message: a PR opened, tests failed then passed, a question, a permission
block, the job went quiet, the job finished or failed. Everything else edits the job card.

The ledger row gets `status`, `cursor`, and `last_summary` on every loop. That makes "what's the
update?" cheap and lets a new session continue the job.

## Flow 4: checking the result

1. Read the final messages and parse the output contract block.
2. Run deterministic checks first: the PR exists and its branch matches the worktree, CI status,
   changed files sit inside the allowed paths, and no production config changed.
3. For code jobs, run the `verifier` subagent. It compares the done-when list with the diff and
   the worker's claims, and returns `pass`, `concerns[]`, and `confidence`.
4. Post one message: verdict, summary, PR link, concerns, the worker thread ID, and the buttons
   Looks good, Fix, and Close. "Fix" sends the reply to the same worker thread.
5. If a PR opened, ask the worker to watch it, so the worker agent can fix CI failures and answer
   review comments. Reconcile reports those wakes in the job thread.
6. When the owner closes the job, settle the worker thread.

## Flow 5: "what's the update?"

- **In a job thread:** `jobs_status(job_id)` reads the ledger row and makes one fresh activity
  read from the cursor. The answer is 2-3 lines: state, last milestone, what it waits on.
- **In a channel or DM:** `jobs_status()` lists active jobs and today's finished jobs, one line
  each, with links to their threads.
- **`/sym status`:** the same list as an ephemeral message.
- **Steering:** "skip the staging test" in a job thread steers the worker thread. "Stop it"
  interrupts it.

## Proactive updates

| Trigger | Source | What Sym does |
|---|---|---|
| Job needs you | watch loop | Post in the job thread at once. Permission blocks go to the owner's DM |
| Job quiet 20 min | watch loop | One post, then at most hourly |
| Worker unreachable | reconcile | Mark jobs `worker_offline`, post once, retry on a timer, post "back" |
| Session died mid-job | reconcile | Start a recovery session in the job thread and re-attach to the worker thread |
| Worker sign-in expires in 5 days | reconcile | DM the owner the re-approve step |
| PR wake | reconcile | Post the CI failure or review in the job thread |
| Daily digest | digest schedule | Finished, failed, waiting, and what Sym learned today |

Noise budget: at most one unprompted message per job per hour, except "needs you" and failures.
The digest carries the rest. [display.md](display.md) defines each message's level.

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Worker host asleep or offline | Worker calls fail | `worker_offline`, retry every 5 min, post once |
| Worker sign-in expired | 401 on every call | Alert 5 days before. Jobs pause until re-approval |
| Launch response lost | Possible duplicate thread | Job ID in the thread title. Look it up before any re-launch |
| Step re-runs after a crash | Duplicate posts or sends | Outbox idempotency keys. Request IDs on worker sends |
| Permission prompt on the worker | Thread waits forever | Detect `waiting` with no question. DM the owner to approve on the worker |
| Eve upgrade | Running sessions stranded | The ledger is the truth. Reconcile re-attaches jobs. Upgrade when no jobs run |
| Worker restart | Running turns interrupted | Reconcile sees `interrupted` and asks whether to resume |
| Brain model error | Turn fails | Eve posts a failure notice. The worker job keeps running; reconcile picks it up |
| Prompt injection from untrusted text | Bad actions | Reading sessions get no write tools. Writes need approval |
