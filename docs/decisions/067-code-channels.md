# 067. Started jobs move into Slack code channels

Status: accepted
Date: 2026-10-29

## Context

Slack Code (docs/slack-code.md) gives an agent app a channel per task, with a status, a context
bar, and an archive step. Eve 0.88 serves a code channel as one session (decision 066). A Sym job
today lives in the thread it was asked in, so a long job shares the thread with side talk, and the
thread has no place for the job's status or links.

The API is new. The help center still says only supported agents may create code channels, so a
create call can fail with `feature_disabled`.

## Decision

1. `SYM_CODE_CHANNELS` turns the feature on. It is off by default, like the other proactive
   features (decision 054).
2. When a person starts a job, Sym creates a code channel before the worker launches. The origin
   is the person's latest message in the thread, else the thread root. `session_id` is
   `sym-J-<id>`, so a retried step reaches the same channel. The job row then names the channel,
   with no thread, and `code_channel` is true. The brief and the Start buttons stay in the thread;
   the card, questions, and result post in the channel.
3. A scheduled check never moves. A job in a direct message never moves, because Slack refuses a
   DM origin.
4. Any Slack refusal keeps the job in its thread. Sym logs the Slack error code only.
5. The context bar shows the job, its project, and its pull request once there is one. The status
   follows the job: `processing`, `suspended` while a worker question waits, `active` at the end.
6. Close archives the channel, with the result post as the summary Slack shares in the origin
   thread. Looks good stays feedback, so Fix still works in the open channel. A Fix follow-up job
   shares its parent's channel.
7. Every message in a code channel reaches the brain with no tag, triage, or listen mode. Each turn
   gets a note naming the channel's job, so the brain steers that job instead of starting another.
8. These calls manage the channel and post no message, so they skip the outbox. Every Slack post
   still goes through `chooseDisplay`.

## Consequences

- The manifest adds the code channel feature, `code_channels:manage`, `channels:read`,
  `groups:read`, `mpim:read`, and `agent_session_stopped`. The owner reinstalls the app.
- The status and context bar update from the job's own task. A job that reconcile finishes after
  its session died keeps its last status until Close.
- Slack's Stop button on the channel stops the brain's turn, not the worker job. The card's Stop
  button still stops the job.
- Not used yet: view tabs, canvases, per-channel slash commands. A diff tab needs the worker's
  diff.
