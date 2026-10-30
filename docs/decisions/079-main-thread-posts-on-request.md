# 079. Post in the main thread on request, from any code channel

Status: accepted
Date: 2026-10-30

## Context

Decision 078 let `job_close` post a summary in the original thread. That tied the summary to
closing. The owner wants the opposite: no summary unless asked, and the ability to post in the
main thread whenever asked, not only at close. A code channel is the same agent as the thread it
came from, so it should not lose a capability there.

Close also passed the result post to Slack as `summary_message_ts`. Slack then labels the session
card in the main thread with that result, so every close showed a summary nobody asked for.

## Decision

1. A new brain tool, `main_thread_post`, posts a message the brain writes in the thread the code
   channel came from. The brain uses it only when a person asks, such as "summarize this in the
   main thread". It works at any time, before or without a close. The post goes through the
   outbox with a display choice. One post per tool call. The reply says "posted" only after Slack
   confirms it.
2. The main thread is the job's origin thread for a job channel. For a conversation channel that
   the `code_channel` tool opened, Sym records the origin thread by the channel's Eve session in a
   new `code_channel_origins` table.
3. `job_close` loses the `summary` option from decision 078 and posts nothing in the main thread.
   Archive passes no `summary_message_ts`.
4. The brain's instructions say a code channel is the same agent as its thread. "Close this and
   summarize it in the main thread" is `main_thread_post`, then `job_close`.

## Consequences

- Closing a channel leaves the main thread unchanged unless a person asked for a post.
- A conversation channel opened before this change has no recorded origin; the tool says so.
- Two routing evals cover "summarize this in the main thread" and "close this and send a summary
  to the main thread". The owner runs evals.
