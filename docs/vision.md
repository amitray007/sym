# Vision

## What Sym is

Sym is a self-hosted, open-source Slack agent. It answers read-only checks itself and turns explicit Builder requests
into tracked jobs on a worker, watches the job, and reports the outcome. A worker is a coding agent that runs somewhere
you control. The first worker is T3 Code, which runs Claude Code and Codex threads on your own
machine and subscriptions.

Sym is useful to anyone who wants to run agent work from Slack: a solo developer, a small team, or
an operations group with scheduled checks. One adopter's playbooks never shape the core.

## Design rules

1. Generic core. The repository names no company, team, or private repository. Adopter
   specifics live in a pack (see [adopting.md](adopting.md)).
2. The ledger is the truth. Every job, schedule, and post is a Postgres row. Eve sessions are
   disposable. A job must survive the loss of its Slack session.
3. Sym delegates. Workers execute. Sym plans, approves, watches, and checks. It does not edit
   repositories itself.
4. Builder work needs explicit consent, including repository investigations. A problem report
   does not authorize a job. Writes need a person. Any job that can change code, data, or settings needs an approval
   for every interactive chat request, including playbooks with historical trust data.
   Approved schedules start without a click (decision 024). The trust ladder no longer auto-starts jobs. Production and customer data stay read-only:
   a job can prepare a change to them, and a person runs it.
5. Quiet by default. Code decides each message's display level. New messages are only for
   "you need to act" and "it is done".
6. Everything learned is readable. Sym does not train a model. Memory, playbooks, and code are
   text and rows that a person can read and revert.
7. Fail visible, not silent. An offline worker, an expired sign-in, or a stuck job produces one
   clear post, then a retry.

## Concepts

| Term | Meaning |
|---|---|
| Owner | The person who installs Sym and approves its sign-ins. The phase-one allow-list holds only the owner |
| Request | A Slack message, mention, slash command, or schedule fire that asks for work |
| Brief | The job spec Sym writes: project, goal, constraints, done-when list, output contract |
| Job | One unit of delegated work with a ledger row, an ID such as `J-142`, and one Slack thread |
| Worker | A system that runs agent threads, reached through a worker adapter |
| Job card | One Slack message per long job that Sym edits in place with explicit progress and no controls |
| Display level | 0 silent, 1 text, 2 text and buttons, 3 live card, 4 summary and file |
| Playbook | An Eve skill that describes how to do one kind of job |
| Pack | An adopter's private set of playbooks, schedules, instructions, and project rules |
| Trust ladder | Per job class, from "approve each run" to "auto", changed only by the owner |
| Reconcile | A schedule that compares the ledger with the workers and repairs drift |

## Build order

1. Milestone 1, the spike. Prove the parts the design depends on: a `worker_job` task tool, the
   watch loop, the job card, `chooseDisplay`, and recovery after a restart. See
   [milestone-1.md](milestone-1.md).
2. Single owner in production. Deploy, schedules with the dispatcher, the outbox, the digest,
   memory, feedback buttons, and evals.
3. Learning. Approved playbooks and rules through `defineDynamic`, the weekly `learn`
   schedule and code changes through worker pull requests.
4. Teams. Per-person scope and policy, shared-channel rules, and more
   worker adapters.
5. More sources. GitHub CI events, error trackers, and ticket systems as event channels.
   Untrusted text gets a reading session with no write tools.
