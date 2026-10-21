# 063. The brain answers quick checks itself

Status: accepted
Date: 2026-10-21

## Context

The brain's instructions said to use `worker_job` for any work in a repository. So a quick
question, such as whether a release pull request is green, started a worker job: a brief, a
Start click, a worktree, and minutes of worker time. The brain often has a faster path: its own
tools and the owner's connections (decision 045) can read a pull request, its checks, or a
release in a few calls.

## Decision

1. The brain decides per request. It does the work itself when its tools and connections can
   answer in a few calls, and says what it found. Questions about a Sym job still go to
   `jobs_status`.
2. It uses `worker_job` when the work changes code or files, needs the repository checked out (to
   run code or tests, or to read across many files), or is a long investigation. A scheduled run
   always calls `worker_job` with its stored brief.
3. It never changes a repository's code or branches itself, even when a connection offers the
   tool. That work goes to the worker. It changes anything else through a connection, such as an
   issue or a release, only when the person it serves asked for that change, and the
   connection's tool mode still applies (decision 049).
4. The Projects list (decision 042) now scopes the brain's own work too, not only worker jobs.
5. When a quick check turns out to need more, it says what it found and offers a job. When no
   tool or connection reaches what was asked, it says so and offers a job instead of guessing.
6. The rule names kinds of work, not tasks, and lives in the instructions. The `worker_job`
   description points to it. A routing eval checks that a quick pull request question starts no
   job and that the reply does not invent the pull request's state.

## Consequences

- Quick checks answer in seconds and cost no worker time or Start click.
- How much the brain can do alone depends on the owner's connections. Without one that reads the
  code host, a pull request question gets an offer of a job.
- A connection's write tools still follow their modes (decision 049), and repository changes stay
  with the worker (AGENTS.md).
- Only the instructions scope the brain's connection reads to the Projects list. Code enforces
  the list for worker jobs only.
