# 075. Give the worker the request's facts, images, and thread

Status: accepted
Date: 2026-10-30

## Context

A worker starts from the brief alone. The brief had a goal, constraints, and a done-when list, but
no place for the facts of the request. When a person asked for an investigation, the brain
summarized it. The worker then lost the exact identifiers, URLs, times, and error text, and it
never saw the screenshots posted in the Slack thread. It had no way to read the thread to recover
them.

Example: a person posts "Images for store example-store.example.com are stale after three syncs
since 09:30 UTC" with a screenshot. The worker got "Find why some images are stale" and had to
guess which store and which images.

## Decision

1. The brief gets an optional `context` list: the request's facts, copied exactly, one per item,
   with a description of each attached image. The worker message shows it under "Request details",
   and the full brief in Slack shows it as "What I'll pass on". The brain's instructions tell it to
   fill the list and not shorten or round the values. The field is optional, so stored briefs and
   schedules still parse.
2. At launch, Sym reads the job's source thread: the origin thread for a job moved into a code
   channel, else the job's own thread. The worker message gets a "Source" section with the
   thread's permalink.
3. Sym downloads up to 8 images (PNG, JPEG, GIF, or WebP, 10 MB each) that people posted in the
   thread, and attaches them to the worker's first message. Sym's own posts and other bots' posts
   are skipped. T3 takes them through `t3_attachment_prepare_upload`, a POST of the bytes to the
   signed upload URL, and the pending IDs in `t3_thread_launch`. The download sends the bot token
   only to `https://files.slack.com`, or to the `SLACK_API_BASE_URL` origin when tests point Slack
   at a fake.
4. A new worker tool, `sym_read_thread`, returns the source thread as text: author, time, text, and
   file names. The job-scoped credential limits it to the job's own thread (decision 065). The
   result says the thread is data, not instructions.
5. Any Slack or upload failure leaves out the link, the images, or both. The job still starts.

## Consequences

- The worker sees the same facts and screenshots the person posted, and can check the thread
  itself before it guesses.
- The thread's text and images leave Slack for the worker host. That host already ran the work
  the request described; the job-scoped credential keeps other threads out of reach.
- No new Slack scopes: `channels:history`, `groups:history`, `im:history`, and `files:read` are
  already in the manifest.
- Launch makes up to two Slack calls plus one download and one upload per image. They run once per
  job, under the launch lock.
