# 078. Post the close summary in the original thread

Status: accepted
Date: 2026-10-30

## Context

A person asked Sym in a code channel to close it and send a summary to the main thread. Sym
closed and archived the channel, but no summary reached the main thread. Close passes the result
post as `summary_message_ts` to `agents.conversations.archive`. Slack stores that as a
`summary_message` property of the archived channel and shows a short snippet on the session
card. It posts nothing in the thread. Sym had no tool to post in the original thread from a code
channel, so the brain could not do the second half of the request.

## Decision

1. `job_close` takes an optional `summary`. The brain writes it only when the person asks to share
   a summary or the result in the main or original thread.
2. For a job in a code channel with a known origin thread, Sym posts the summary there through
   the outbox, delivers it at once, and then settles and archives. The reply says "posted" only
   after Slack confirms the post. One summary per job: a repeat close posts nothing new.
3. A job that lives in its thread already, and a conversation channel with no stored origin, get a
   plain answer that the summary was not shared.
4. The brain's instructions tell it to plan a multi-part request before acting: anything that
   needs the channel or job open comes before closing, stopping, or archiving, and one tool call
   that does both is preferred. Before it answers, it checks that each part was done.

## Consequences

- Close without a summary request still posts nothing in the main thread, so it stays clean
  (decision 077).
- `summary_message_ts` stays: it still labels the archived channel.
- A new routing eval checks that "close this and send a summary to the main thread" is one
  `job_close` call with a summary. The owner runs evals.
