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
 │  tools/worker_job.ts     one job = task  │  callback URL   └───────────────────────────┘
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
| `jobs` | ID, kind, Slack channel and thread, brief, worker, thread ID, launched model, status, cursor, last summary, job card `ts`, display choice, parent job and close (decision 056), playbook and outcome (decision 059), credential-free worker identity (decision 065) |
| `worker_capabilities` | Private per-job worker credentials and MCP endpoints; terminal jobs cannot use them (decision 065) |
| `schedules` | Cron (UTC), stored brief, approval state, lease |
| `outbox` | Pending Slack posts with an idempotency key and the `chooseDisplay` result. Refuses level 0 and missing choices |
| `feedback` | Buttons, reactions, "Fix" replies, brief edits, linked to a job |
| `memory` | Facts and preferences (learning layer 1) |
| `playbooks` | Approved playbooks and rules with version history (learning layer 2), historical trust fields |

Job statuses: `launching`, `running`, `waiting_input`, `waiting_permission`, `quiet`,
`worker_offline`, `checking`, `done`, `failed`, `cancelled`.

## Flow 1: someone asks for work

Example: "@sym add retry with backoff to the billing sync in sync-service, open a draft PR".

The brain checks read-only facts with its own tools first. A problem report does not grant
Builder consent (decision 071). A job needs an explicit Builder request or acceptance of a
specific offer, including for repository investigations. Sym never edits repositories itself.
Interactive chat requests show Start / Not now, even for trusted playbooks. Approved schedules
start without a click (decision 024). The trust ladder no longer auto-starts jobs.

1. `onAppMention` checks the sender against the allow-list and starts a session for the thread.
2. The model loads the `task-brief` playbook and writes a brief: project, goal, constraints, a
   done-when list, and an output contract. The contract is a final JSON block with `summary`,
   `pr_url`, `tests`, `files_changed`, and `open_questions`.
3. The model calls `worker_job`, an Eve task, so the conversation stays open. It writes a `jobs` row
   with status `launching`, keyed on the tool call ID, and takes the Slack thread of the session.
4. Sym posts a short brief with Start / Not now. Typed approval binds to one current proposal.
   A revised brief expires the old proposal. Start rechecks current project policy. The ledger
   keeps the callback so reconcile can recover an approved start. A committed click or addressed
   typed decision wakes a separate Start hook immediately. The task reads the ledger again before
   launching. Its twelve five-minute fallback waits still bound idle workflow events. After Start:
   - It looks for a worker thread whose title holds the job ID. If one exists, it adopts it. This
     stops a re-run step from launching twice.
   - It launches the thread: title `[J-142] Billing sync retry`, a new worktree, the model the
     worker reports, runtime mode `auto`. The message is the brief, the output contract, and the
     callback URL.
   - It saves the thread ID and posts the job card when the display rule picks level 3, or one
     start line otherwise (decision 020).
5. The watch loop runs until the thread ends.
6. Sym checks the result and posts the outcome in the thread.

## Flow 2: a schedule fires

Example: "Every weekday at 09:00, run the on-call check and tell me only what needs attention."

1. The owner says it once. Sym calls `schedule_create`, which needs approval. Sym shows the row:
   cron in UTC, project, brief, runtime mode, read-only. That approval covers every fire.
2. Every minute, `dispatch` claims due rows with a lease, so a row cannot fire twice.
3. For each due row, `dispatch` starts a session in the schedule's channel with
   `to(slack, { channelId })` and no root message, and records a `schedule_runs` row.
4. The model calls `worker_job` with the stored brief and the schedule reference. The job skips the
   Start click only when the session came from the dispatcher and the brief equals the approved
   one (decision 024).
5. The scheduled job posts nothing while it runs. When the check is clean, nothing posts at all,
   and the evening digest, when it is on, lists "On-call check: all clear". When something needs attention, one
   message posts and opens the thread (decision 031).

A pack can seed schedules from `schedules.yaml`. They start pending, and the owner approves each
with `schedule_approve` (decision 055).

Sym owns schedules instead of the worker (decision 008). Sym then knows each run before it starts,
so it can open the thread, record the job, and pick the display level.

## Flow 3: watching a running job

```
loop:
  race(callback webhook, sleep 4 min)
  worker.wait(threadId, 60 s)            -> status, timedOut
  worker.readActivity(threadId, cursor)  -> new items, next cursor
  if status == waiting:
      worker.pendingQuestions() -> questions? -> ledger-backed question in current conversation -> worker.answer()
                                -> none?      -> permission prompt -> DM the owner once
  update the job card (chat.update), yield a short status line
  if material change:            post (through chooseDisplay)
  if no new activity for 20 min: edit the working note
  if no new activity for 45 min: ask once whether to stop
  if terminal: break
```

Progress silently edits the working note. A PR opening creates no new post. Questions,
permission blocks, the long quiet notice, completion, and failures can notify.

The ledger row gets `status`, `cursor`, and `last_summary` on every loop. That makes "what's the
update?" cheap and lets a new session continue the job.

## Flow 4: checking the result

1. The worker finishes. For a code job, `checkJob` moves the job to `checking`, and the working note says
   Sym is checking the result. Nothing posts yet.
2. Read the final message and parse the output contract block.
3. Run the deterministic rule checks first (`lib/jobs/verify.ts`): changed files sit inside the
   allowed paths, and a PR opened only when the job allowed one. When the job ends, one step asks
   the worker for the thread's pull request facts (`pullRequests`, decision 057) and stores them on
   the job row, so a re-presented result shows the same checks. The facts add generic checks: the
   reported PR link is one of the thread's PRs, an open PR the worker did not report (the result
   then links it), the base branch, the draft rule, a merged or closed PR, and a head branch equal
   to the base. A worker without the call, or a failed call, skips these checks. CI status is not
   read here. It arrives only as PR-follow wakes (`SYM_PR_FOLLOW=on`, step 5). Production
   configuration and data changes are judged by the verifier, not by rules.
4. With `SYM_VERIFIER=on` (decision 054), the `worker_job` body runs the `verifier` subagent
   through `ctx.agent` (decision 032). It gets the
   brief, the rule-check concerns, the PR facts, and the worker's claims as untrusted data. It compares the
   done-when list with the claims and returns `pass` or `concerns`, `concerns[]`, and
   `confidence`. It has no tools.
5. With the writer on (`SYM_RESULT_WRITER`, default on), the body then runs the `writer`
   subagent (decision 062). It gets the persona, the approved playbooks and rules, the job facts,
   the concerns from both checks, and the worker's result and report as untrusted data, and
   writes the result text with no template. It has no tools.
6. `finishJob` marks the result, collapses the working note, and posts human text. Code adds
   exact sentences from inline fact tokens, then only missing concerns, open decisions, PR and test facts. Results have links, optional choices,
   and optional native feedback. No fixed result checklist or confidence score is shown.
   `job_followup` proposes a change on the finished thread and branch. Start checks the stored
   revision, actor, current project policy, and worker identity. The new job gets its own scoped
   credential. One job per worker thread is active at a time.
7. With `SYM_PR_FOLLOW=on` (decision 054), if a PR opened, ask the worker to watch it, so the
   worker agent can fix CI failures and answer review comments. Reconcile reports those wakes in
   the job thread.
8. `job_close` records a close request, settles the worker, stops PR following, and requests
   code-channel archive. Reconcile retries unfinished closure. Archive success requires Slack
   confirmation; refusals leave a retry control. Discussion stays chat, running redirects use
   `job_steer`, and explicit stops use owner-confirmed `job_stop`.

The model check is skipped, and the job ends with the rule checks alone, when `SYM_VERIFIER` is
not on (the result then has no verifier line), when reconcile finishes
an orphaned job (including one left in `checking`), for a scheduled check, when the task stops or
fails while checking, and when the verifier fails or times out. In the last case the result says
"Model check unavailable". The writer is skipped in the same cases, for a follow-up, and when
it fails or times out; the result then uses the template.

## Flow 5: "what's the update?"

- **In a job thread:** `jobs_status(job_id)` reads the ledger row and makes one fresh activity
  read from the cursor. The answer is 2-3 lines: state, last milestone, what it waits on.
- **In a channel or DM:** `jobs_status()` lists active jobs and today's finished jobs, one line
  each, with links to their threads.
- **`/sym status`:** the same list as an ephemeral message.
- **Steering:** "skip the staging test" in a job thread steers the worker thread, and so does the
  conversational `job_steer` path. "Stop it" uses owner-confirmed `job_stop`.

## Proactive updates

| Trigger | Source | What Sym does |
|---|---|---|
| Job needs you | watch loop | Post in the job thread at once. Permission blocks go to the owner's DM |
| Job quiet 20 min | watch loop | One post, then at most hourly |
| Worker unreachable | reconcile | Mark jobs `worker_offline`, post once, retry on a timer, post "back" |
| Session died mid-job | reconcile | The watcher lease runs out; reconcile checks the job in code until it ends (decision 022) |
| Worker sign-in expires in 5 days | reconcile | DM the owner the re-approve step |
| PR wake | reconcile | Post the CI failure or review in the job thread. Only with `SYM_PR_FOLLOW=on` |
| Daily digest | digest schedule | Finished, failed, waiting, and what Sym learned today. Only with `SYM_DIGEST=on` and a digest channel |

Noise budget: at most one unprompted message per job per hour, except "needs you" and failures.
The digest, when it is on, carries the rest. The digest, the verifier, and PR follow are opt-in
(decision 054). [display.md](display.md) defines each message's level.

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
