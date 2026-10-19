# 028. The worker callback uses a configured base URL

Status: accepted
Date: 2026-10-20

## Context

The worker POSTs to a callback URL when it finishes, so Sym wakes before its next poll
(docs/workers.md). Milestone 1 asked whether `createWebhook` returns the public or the private
host. The local end-to-end run answered it: off Vercel, Eve's workflow runtime builds webhook URLs
as `http://localhost:3000`, whatever host or port Sym listens on. A worker on another machine
cannot reach that.

## Decision

`SYM_CALLBACK_URL` is the base a worker can reach, such as Sym's address on the private network.
The `t3_job` launch step keeps the path and token Eve generated and puts them on that base
(`lib/jobs/callback.ts`). Without the variable, Sym passes Eve's URL unchanged.

## Consequences

A deployment sets `SYM_CALLBACK_URL`, or every job waits for the 4-minute poll. The webhook path
`/.well-known/workflow/` must reach Sym from the worker host. The callback only wakes Sym early;
the poll still finds every result.
