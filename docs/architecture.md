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
 │  channels/webhook.ts signed webhooks │                 │                           │
 │  channels/github.ts, linear.ts       │                 │                           │
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
| Dispatch | Fires due schedule rows every minute, with a lease per row, and sends deferred trigger runs |
| Outbox | Durable Slack posts with an idempotency key per post |
| Sandbox | Opt-in (`SYM_SANDBOX`). One limited Docker container per Slack thread for the brain's shell and file tools: compute, shared files, small scripts. No secrets, no repository credentials, no network by default. Repository work stays with workers (decision 089) |

Only the Slack route, the workflow webhooks, the webhook routes (`/sym/hooks/`,
`/sym/reveal/`), and, when configured, the GitHub and Linear routes (`/eve/v1/github`,
`/eve/v1/linear`) are public. The MCP channel, the HTTP channel, and the worker stay on a
private network such as a tailnet ([self-hosting.md](self-hosting.md)).

## The job ledger

The ledger is the source of truth. Eve sessions and tasks are not. A self-hosted Eve upgrade
strands running sessions, so every job keeps enough state to continue in a new session.

| Table | Holds |
|---|---|
| `jobs` | ID, kind, Slack channel and thread, brief, worker, thread ID, launched model, status, cursor, last summary, job card `ts`, display choice, parent job and close (decision 056), playbook and outcome (decision 059), credential-free worker identity (decision 065) |
| `worker_capabilities` | Private per-job worker credentials and MCP endpoints; terminal jobs cannot use them (decision 065) |
| `schedules` | Cron (UTC) or one-time run, instruction, Builder mode, destination channel, creator, status, lease |
| `triggers` | Event trigger: kind (message or reaction), watched channel, keywords or emoji, instruction, Builder mode, destination, creator, status (decision 088) |
| `schedule_runs` | One row per run of a schedule or a trigger: outcome, session, job; a trigger run also keeps its event key and facts |
| `outbox` | Pending Slack posts with an idempotency key and the `chooseDisplay` result. Refuses level 0 and missing choices |
| `feedback` | Buttons, reactions, "Fix" replies, brief edits, linked to a job |
| `memory` | Facts and preferences (learning layer 1) |
| `playbooks` | Approved playbooks and rules with version history (learning layer 2), historical trust fields |

Job statuses: `launching`, `running`, `waiting_input`, `waiting_permission`, `quiet`,
`worker_offline`, `checking`, `done`, `failed`, `cancelled`.

## Flow 1: someone asks for work

Example: "@sym add retry with backoff to the billing sync in sync-service, open a draft PR".

The brain checks read-only facts with its own tools first. A multi-source question can use the
isolated `researcher`, which reads public web pages, searches when supported, reads Slack under
the parent conversation's privacy rules, and reads saved job status. It cannot post, change state,
use connections, or start Builder work. Independent research tasks can run in parallel. Repo and
pack skills load procedure text on demand through `eve__skill`; neither research nor skills give
worker callers new access (decision 087). A problem report does not grant
Builder consent (decision 071). A job needs an explicit Builder request or acceptance of a
specific offer, including for repository investigations. Sym never edits repositories itself.
Interactive chat requests show Start / Not now, even for trusted playbooks. Runs of a schedule
set to `auto` start without a click (decision 085). The trust ladder no longer auto-starts jobs.

1. `onAppMention` checks the sender against the allow-list and starts a session for the thread.
   Audio on the message is transcribed first and joins the turn as a context note (decision 092).
2. The model loads the `task-brief` playbook and writes a brief: project, goal, the request's
   exact facts (decision 075), constraints, a done-when list, and an output contract. The
   contract is a final JSON block with `summary`, `pr_url`, `tests`, `files_changed`, and
   `open_questions`.
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

Example: "Every weekday at 09:00, check the open PRs and tell me only what needs attention."

1. A person on the allow-list says it once. Sym calls `schedule_create` with a title, the
   instruction, and a cron in UTC or a one-time `at` time. If a run might need Builder work, the
   brain first asks whether Builder starts on its own (`auto`) or asks each time (`ask`, the
   default), and where to ask: this channel, another channel, or a DM. The row is active at once;
   the person's setup is the consent for its runs (decision 085).
2. Every minute, `dispatch` claims due rows with a lease, so a row cannot fire twice. A run whose
   creator left the allow-list does not start.
3. For each due row, `dispatch` starts a session in the schedule's destination channel with
   `to(slack, { channelId })` and no root message, and records a `schedule_runs` row. The message
   gives the instruction, the Builder mode, and the schedule reference.
4. The brain does what the instruction asks with its tools. The run acts for the schedule's
   creator: Slack tools use the creator's reach, and only the creator can approve a gated step in
   the run (decision 085). When the instruction asks for Builder
   work, it calls `worker_job` with a brief inside the instruction's scope and the schedule
   reference. The job skips the Start click only when the session came from the dispatcher, the
   reference matches this session's run, the row is active (or done, for a one-time row), its
   Builder mode is `auto`, and the project is on the list. Otherwise it shows Start / Not now.
5. An auto-started job posts nothing while it runs. When the check is clean, nothing posts at
   all, and the evening digest, when it is on, lists "On-call check: all clear". When something
   needs attention, one message posts and opens the thread (decision 031). A run with nothing to
   say calls `no_reply`. A run with no job ends with its turn: all clear when silent, needs
   attention when it posted.
6. A one-time row ends as `done` after its fire.

A pack can seed schedules from `schedules.yaml`. They start active (decisions 055 and 085).

Sym owns schedules instead of the worker (decision 008). Sym then knows each run before it starts,
so it can open the thread, record the job, and pick the display level.

## Flow 2b: an event trigger fires

Example: "When someone posts a bug report in #support, draft a ticket in its thread."

1. A person on the allow-list says it once. Sym calls `trigger_create` with a title, the
   instruction, `on` (`message`, with optional keywords, or `reaction`, with one emoji), the
   watched channel, and an optional destination: the event message's thread (the default), a
   channel, or the creator's DM. Sym and the person must both be in the watched channel, because
   Slack sends events only from channels Sym is in (decisions 081 and 088). The Builder question
   is the same as for schedules. The row is active at once.
2. A new top-level message reaches `onMessage`, and a reaction reaches `onEvent`. Messages that
   mention Sym and replies in threads keep their normal path; only a new top-level message or a
   reaction can fire a trigger. Bots and Sym's own posts and reactions fire nothing, so a run
   cannot fire itself. Anyone's message can fire a trigger; its author is not the requester.
3. For each matching trigger, Sym reserves a `schedule_runs` row keyed by the trigger and the
   event (one run per message), so a Slack retry fires nothing. Each trigger starts at most
   `SYM_TRIGGER_RUNS_PER_HOUR` runs an hour (default 20). The creator must still be allowed and
   a member of the watched channel, or the run fails closed. Each run gets its own session: the
   first eligible run claims the event's thread in `trigger_threads`, across the message and
   reaction paths, and any other runs in its creator's DM.
4. Sym sends the run message as the app principal, the same proof of a run a schedule uses:
   `ctx.send` in the event message's thread, or `ctx.send` with a target from `onEvent`. A
   message handler can start a session only in its own thread, so a message trigger that posts
   elsewhere leaves its run deferred, and the next `dispatch` tick claims it with a lease and
   sends it with `to()`, rechecking the creator first. Every send uses the scheduled run's send
   mark, delivery key, and locked attach.
5. The run message carries the instruction and the event's facts (channel, link, author, text)
   as JSON data that grants nothing. The brain decides from the instruction; most events need
   nothing, so it calls `no_reply`. Steps 4 to 5 of flow 2 apply: the run acts for the creator,
   and `worker_job` skips Start only for an active `auto` trigger whose run this session is, in
   the run's own turn. Every turn of a run's session, a person's follow-up included, counts as
   one that read untrusted content, so a post or DM elsewhere waits for approval (decision 082).
6. A run that stays silent leaves its thread to the people there: their replies start no turn.
   A mention still does, and once any person talks to Sym there the rule ends.

"Send to Sym" on a message's menu is not a trigger. Sym posts a DM to the person who picked the
message, quoting it and asking what to do. The person's reply in that thread is their own
request. Eve's shortcut handler cannot start a session, so the reply starts it (decision 088).

## Flow 2c: a webhook trigger fires

Example: "When our deploy tool reports a failure, summarize it in #ops."

1. A person on the allow-list says it once. Sym calls `trigger_create` with `on: webhook`, the
   instruction, and an optional destination: this conversation (the default), a channel the
   person and Sym share, or the creator's DM. The row gets an unguessable hook ID and is active
   at once. It stores no secret.
2. Sym DMs the creator the URL, `<public base>/sym/hooks/<hook id>`, and a one-time link to
   `<public base>/sym/reveal/<token>`, with unfurls off. The link lasts 15 minutes. A GET shows
   a "Reveal secret" button; only its POST, with the page's form token, shows the secret, once.
   The secret derives from `SYM_WEBHOOK_KEY`, the hook ID, and the secret version, so Sym never
   stores it, and Postgres keeps only a hash of the link's token. The secret never enters Slack,
   the tool result, `trigger_list`, or a log.
3. The sender POSTs with `x-sym-timestamp` (Unix seconds) and `x-sym-signature` (`sha256=` plus
   the hex HMAC-SHA256 of `<timestamp>.<raw body>`). The route `channels/webhook.ts` refuses a
   request without both headers before any database read, reads at most 64 KiB, checks the
   signature in constant time and the timestamp within 5 minutes, and refuses a paused trigger
   or a creator off the allow-list or out of the destination channel. A hook with 30 bad
   signatures in a minute gets 429.
4. Sym reserves one `schedule_runs` row keyed by a hash of the signature, with a hash of the body
   as a second key for 10 minutes, so a replay or a re-signed copy fires nothing, whatever
   unsigned headers change. The hourly cap of flow 2b applies (429 past it). The row is
   deferred; the route answers 202, then takes the dispatcher's 2-minute lease on the row and
   sends the run with `to()` as the app principal into a new thread at the destination. A failed
   send keeps the run deferred, and a `dispatch` tick after the lease sends it with the same key,
   until it is 10 minutes old and fails. Every turn of the run's session counts as having read
   untrusted content (flow 2b).
5. The run message carries the instruction and the request's facts (media type, time, and the
   body: JSON parsed, else text, cut at 8,000 characters) as JSON data that grants
   nothing. Steps 4 to 5 of flow 2 apply: the run acts for the creator, and `worker_job` skips
   Start only for an active `auto` trigger whose run this session is.
6. `trigger_rotate_secret` bumps the secret version for the creator only, so the old secret
   stops at once, and DMs a new one-time link (decision 090). Sym's own Slack reads redact
   anything shaped like a webhook secret.

## Flow 2d: GitHub and Linear events

Example: "When a PR is opened in example-org/example-app, summarize it here", or a person
mentions the GitHub App in a PR, or delegates a Linear issue to Sym.

1. Eve's GitHub channel (`/eve/v1/github`) and Linear channel (`/eve/v1/linear`) verify each
   webhook's signature with the app's secret and call Sym's hooks. Without their variables,
   each route answers 404 (decision 091). Every hook returns no dispatch: no session runs on
   GitHub or in Linear.
2. Triggers: `trigger_create` with `on: github` stores a filter (repository, event types
   `pull_request`, `issues`, `check_suite`, `issue_comment`, actions, label, branch); `on:
   linear` stores a team, actions, and label for issue events. Each matching event reserves one
   deferred run per trigger, keyed by the delivery ID and a hash of the signed content, on a
   listed repository only, under the hourly cap of flow 2b. The hooks have no `to()`, so the next
   `dispatch` tick sends the run as the app principal into a new thread at the destination,
   within a minute. The creator check of flow 2b applies to the
   destination channel, after the reservation and before the send. The run message carries the
   event's facts (repository, number, title, link, sender, labels, branch, conclusion, body) as
   untrusted JSON data, and every turn of the session counts as having read untrusted content.
   The run acts for the creator; `worker_job` keeps the auto and ask rules.
3. Requests: a GitHub comment that mentions `@<GITHUB_APP_SLUG>`, or a Linear Agent Session (a
   delegation or a follow-up prompt), counts as a request only when the pack's `identities` (or
   `SYM_GITHUB_USERS`, `SYM_LINEAR_USERS`) maps the user to an allowed Slack person: a GitHub
   account by its numeric ID, a Linear prompt by its author's user ID. Only repositories on the
   owner's list (`SYM_GITHUB_REPOS` or the pack's `githubRepositories`) count at all. Sym then
   posts in that person's DM like Send to Sym: a link, a quote, and "What should I do with it?".
   Their reply is their own request, with Start / Not now for Builder work. Sym answers on GitHub
   with a comment, or in Linear with a `response` activity, saying where to continue. Anyone else
   gets a polite refusal there.

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
| Prompt injection from untrusted text | Bad actions | Reading sessions get no write tools. Writes need approval. The sandbox holds no secrets and has no network by default, so injected commands there reach nothing outside it |
| Busy watched channel | Many trigger runs, model spend | Keywords narrow the events; each trigger starts at most `SYM_TRIGGER_RUNS_PER_HOUR` runs an hour; a Slack retry finds its run |
| Sandbox unavailable (sandbox off, no Docker socket, daemon down) | Shell and file tools fail | Each tool returns a short error and the turn continues. Shared files reach the brain as a note with their name (decision 089) |
| GitHub or Linear event loop | A run's Builder work opens a PR that fires the same trigger again | Each delivery fires once, the hourly cap bounds the loop, and comments by bots fire nothing |
| Leaked webhook secret | Anyone can start runs that act for the creator | Signatures expire after 5 minutes and each request fires once; the hourly cap bounds spend; the creator rotates the secret or pauses the trigger |
| Webhook sender floods the URL | Load on the public route | Unsigned requests stop at the signature check before any model work; bodies over 64 KiB get 413 |
