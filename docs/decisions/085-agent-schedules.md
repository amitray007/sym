# 085. A schedule is an instruction for the agent

Status: accepted
Date: 2026-11-03

## Context

A schedule was a stored Builder brief (decision 024). Each fire told the brain to call
`worker_job` with exactly that brief, so the brain decided nothing. A person could not schedule
"post the open PRs in #team every morning" or "remind me at 3pm" without a Builder job. Every
schedule also needed the owner's approval, even when the person who asked was on the allow-list.

## Decision

1. A schedule holds a free-form `instruction`: what to do on each run. Each run gives the brain
   the instruction, and the brain decides what to do with its normal tools: read, post, check
   pull requests, start Builder, or nothing. `worker_job` is one tool among the others.
2. Each schedule has a Builder mode, chosen at setup: `auto` (a run may start Builder work with
   no Start click) or `ask` (the run posts Start / Not now). The default is `ask`. When a
   schedule might need Builder work, the brain asks one question: start on its own, or ask each
   time? If the answer is "ask", the brain asks where: this channel, another channel, or a DM to
   the person. Otherwise it asks nothing.
3. Each schedule posts its runs in one destination, stored in `channel`: the conversation's
   channel by default, another channel that the person and Sym both belong to (decision 081), or
   a DM with the person. A DM resolves to its channel ID with `conversations.open` at setup, so
   no new column is needed.
4. Anyone on the allow-list creates, pauses, resumes, and deletes schedules. There is no owner
   approval: the person's setup is the consent for its runs. A new row is `active` at once.
   `schedule_approve` is removed. A worker thread and a scheduled run (the app principal) cannot
   change schedules. The dispatcher skips a run whose creator has left the allow-list, and marks
   the run `failed`.
5. A one-time schedule has `at` (an ISO time in UTC) in place of `cron`. Exactly one of them is
   set, and the database checks it. After its one fire, the row is `done` and leaves
   `schedule_list`.
6. `worker_job` skips the Start click only when all of these hold in code: the session's
   initiator is the schedule app principal, the schedule reference matches the run attached to
   this session, the row is `active` (or `done` for the one-time row whose fire started this
   run), its Builder mode is `auto`, and the project is on the list (decision 042). Whatever the
   mode, `worker_job` rechecks the creator at launch: when the creator left the allow-list after
   the dispatch, the run starts no Builder work and says why. The brief no
   longer has to equal a stored brief: the brain writes it within the instruction's scope. Any
   other case shows Start / Not now. An auto-started run stays a quiet `scheduled-check`
   (decision 031).
7. A pack's `schedules.yaml` entry has `instruction` and an optional `builder` (default `ask`) in
   place of `brief`. The deployer wrote the entry, so a seeded row is active at once, and Sym
   sends no notice. A changed entry updates its row. A row someone paused stays paused. A removed
   key is deleted, and a returning key comes back active. An old entry with `brief` fails the
   pack check and names the field.
8. Migration `034_agent_schedules` adds `instruction`, `builder`, and `run_at`, makes `cron`
   nullable, adds status `done`, and drops `brief`, `approved_by`, and `approved_at`. An old row
   gets the instruction "Start the builder with this brief." and its brief in a `brief` block. A
   row that was approved gets `builder = 'auto'`, so it keeps its click-free start. A row that
   waited for approval was never approved, so it becomes `paused`; anyone allowed can resume it.
   The migration has no rollback, and it drops the approval metadata (who approved each row and
   when) for good.
9. A scheduled run acts for the schedule's creator. The dispatcher still sends with the app
   principal, the code proof that the session is a run, and `worker_job` relies on it.
   `requesterOf` in `lib/requester.ts` is the one requester lookup for every tool: a person's
   turn acts for that person; a schedule session with an attached run acts for the run's
   creator while the creator is on the allow-list; any other app or worker session acts for
   nobody. So `slack_read`, `slack_post`, `slack_react`, `slack_dm`, and the other tools work in
   a run with the creator's reach, and owner-only tools work only when the creator is the owner.
   Schedule management stays closed to runs, so a run cannot create or change schedules. The
   turn records the creator as the person its Slack thread serves, so a run in the creator's DM
   can share what the creator may read (decision 083).
10. An approval inside a run (`requesterResponse`) accepts only the creator, because the request
    principal there is the app. Every other approval rule stays the same.
11. A run that starts no Builder job ends with its turn: `needs_attention` when the turn posted,
    `all_clear` when it stayed silent (`no_reply`), and `failed` when the turn did not complete.
    A turn that called `worker_job` leaves the outcome to the job's end, as before. Migration
    `035_schedule_run_settlements` keeps the first settlement by session, so a turn that ends
    before the dispatcher attaches its session still sets the outcome on attach. The attach and
    the settlement take the same per-session advisory lock, so neither misses the other.
12. Each run is delivered with the idempotency key `sym-schedule-run:<run id>`, so a retry
    reaches the same Slack session. A one-time run that a dispatcher reserved but never
    delivered is sent again, for up to an hour, before its row is `done`. A recurring fire left
    undelivered is skipped, and its run ends `failed`. Migration `036_schedule_run_sent_at`
    records each delivery attempt, so a turn that starts before the attach of a retried
    delivery still waits for it and acts for the creator.
13. `runMessage` in `lib/schedules/format.ts` builds a run message from the reference, title,
   instruction, Builder mode, and creator. It is the seam a later event trigger can use: a
   message in a watched channel is also an instruction, a Builder mode, and a destination.

## Consequences

- This supersedes the approval in decision 024 and the pending pack rows and `schedule_approve`
  in decision 055. Decision 071 retired the playbook auto-start of decision 059, so schedules in
  `auto` mode are the only click-free start. The lease, the run rows, the outcomes, the
  project list, the quiet rule (decision 031), and read-only production and customer data stay.
- A run reaches only what its creator can reach today. When the creator leaves the allow-list,
  the run stops, and a run already in progress loses its reach.
- A run whose Builder job waits for Start and gets Not now keeps the outcome `started`, which the
  digest shows as "ran, no result yet".
- In `auto` mode, the brain can start Builder work that the instruction asks for, with a brief
  the person did not see. The project list and the instruction's scope bound it, and the job
  stays read-only for production and customer data.
