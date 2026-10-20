# 057. Result checks from the worker's pull request facts

Status: accepted
Date: 2026-10-21

## Context

Flow 4 step 3 left the PR branch, CI status, and production config unchecked, because they need the
worker or GitHub. The T3 worker lists the pull requests linked to a thread, with state, branches,
and draft flag. It reports no CI status. Checks must stay generic: no rule may depend on a kind of
task, and judgment calls belong to the model.

## Decision

1. `WorkerAdapter.pullRequests?(threadId)` returns `PullRequestFacts[]`. T3 calls
   `list_thread_pull_requests` and drops entries that do not parse.
2. When a code job ends, `checkJob` reads the facts once and stores them in `jobs.pr_facts`
   (migration `019_job_pr_facts`). A re-presented end reads the row, not the worker. A scheduled
   check skips the read. A missing method or a failed call stores nothing, and the checks that
   need facts do not run.
3. `checkResult` adds these checks, each only on facts it has: the reported PR link is not among
   the thread's PRs (only when the list is not empty, because a PR the worker never linked is not
   proof of a false link); the thread has an open PR the worker did not report (the result then
   links it, and the job's PR rule applies to it); the base branch differs from the brief's `baseRef`, else the pack project's
   `defaultBaseBranch`; the project's `prPolicy` is `draft` and the PR is ready for review; the PR
   is merged or closed; the head branch equals the base.
4. With `SYM_VERIFIER=on`, the verifier gets the facts as untrusted data and judges from the
   brief, the changed files, and the facts whether the change touches production configuration or
   data, secrets, deployment or CI settings, or migrations without the brief asking for it.
5. CI status stays with PR-follow wakes (decision 034, `SYM_PR_FOLLOW=on`). Nothing new reads CI.

## Consequences

The read adds one worker call per ended code job. A worker that does not link its PR to the
thread gets the "not reported" concern only if another PR is open; a worker with no linked PRs
gets no link check. The risk judgment costs nothing extra when the verifier is off, and it then
does not run.
