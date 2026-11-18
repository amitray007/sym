# 099. One setting per kind of approval click

Status: accepted
Date: 2026-11-18

## Context

Sym asks a person to click before five kinds of action: Start on Builder work (decisions 060,
085), connection tools in `ask` mode (045, 049), posts and edits outside the run's own reply
(081, 082, 088), DMs to other people (083), and owner changes to connections, playbooks, and
running jobs. Each rule is right for a deployment where a person is present. An always-on
deployment, such as one that reads alerts from a webhook trigger and pages a user group, stalls
at the first click nobody makes. A trigger run always asks before it posts anywhere else, so it
can never page `@on-call` on its own.

An owner can run a second, narrower deployment for this: its own Slack app, database, and
connection credentials, with fewer people and less data to reach. That deployment needs the
same code with fewer clicks.

## Decision

1. Five environment variables set the clicks: `SYM_APPROVAL_START`, `SYM_APPROVAL_CONNECTIONS`,
   `SYM_APPROVAL_POSTS`, `SYM_APPROVAL_DMS`, and `SYM_APPROVAL_ADMIN`. Each takes `rules` (the
   default: Sym's own rules), `always` (ask every time), or `never` (skip the click). Any other
   value keeps `rules`, so a typo never opens a gate. `lib/approvals.ts` owns the parsing.
2. A mode changes only the click. The allow-list, the owner checks inside each tool, the reach
   checks, the hourly post cap, hidden connection tools, and the read-only brief rule for
   production data (decision 064) stay.
3. There is no mode where the brain decides. In a trigger run, the brain's judgment is what an
   untrusted event can steer, so `never` is the honest form of automatic.
4. `SYM_APPROVAL_START=never` starts every interactive job: the brief posts without buttons and
   ends with "Starting now.", and its Start proposal is recorded as approved by the person the
   thread serves, so reconcile and the ledger still see who started it. A follow-up starts at
   once instead of posting a proposal. Every schedule and trigger run starts its Builder work,
   whatever its row's `builder` mode. `always` asks even for an `auto` row.
5. `SYM_APPROVAL_CONNECTIONS=never` runs every `ask` tool without the owner's click. `always`
   asks for every tool, `auto` ones included.
6. `SYM_APPROVAL_POSTS` covers `slack_post`, `slack_edit`, `slack_bookmark`, `slack_canvas`, and
   `main_thread_post`. With `never`, a trigger run can post in another channel and ping a user
   group such as `@on-call`. `SYM_APPROVAL_DMS` covers `slack_dm`.
7. `SYM_APPROVAL_ADMIN` covers `connection_approve`, `connection_remove`, `connection_tools`,
   `playbook_review`, `playbook_retire`, and `job_stop`. `never` skips the click only on a
   person's own turn. A scheduled or trigger run still asks, because an untrusted event must not
   approve a connection or a playbook.
8. The settings note (decision 097) lists each mode, so the brain can say why it did or did not
   ask.

This changes the AGENTS.md invariant that every interactive chat job shows Start / Not now: it
holds unless `SYM_APPROVAL_START=never`.

## Consequences

The default deployment behaves as before. An owner who sets `never` accepts that the brain acts
on what it reads with nobody in the loop: a poisoned alert can make it post, ping, DM, or start
Builder work as far as the credentials and allow-lists reach. The safe pattern is a separate
deployment with read-only connection credentials, a short allow-list, and only the channels it
needs. The Postgres-backed tests for the Start path run in CI.
