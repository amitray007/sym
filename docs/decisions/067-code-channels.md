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
   with no thread, `code_channel` is true, and the origin columns keep the thread. The brief and
   the Start buttons stay in the thread; the card and result post in the channel.
3. Worker questions stay in the thread too. `worker_job` runs in the thread's Eve session, and
   Eve asks there. The channel posts the question with a link to the thread and shows
   `suspended` until it is answered.
4. A scheduled check never moves. Neither does a job in a direct message, a group DM, a Slack
   Connect channel, or a code channel, because Slack refuses those origins or would nest channels.
5. A private thread gets a private channel. If Slack opens it as public anyway, Sym archives it
   and keeps the job in its thread, as Eve does.
6. Any Slack refusal keeps the job in its thread. Sym logs the Slack error code only. A failed
   ledger write after the channel exists retries the step, which reaches the same channel.
7. The context bar shows the job, its project, and its pull request once there is one. The status
   follows the job: `processing`, `suspended` while a worker question waits, `active` at the end
   and when the job stops or fails. Eve also sets the status for each brain turn in the channel,
   so the job sets `processing` again after each check.
8. Close archives the channel, with the sent result post as the summary Slack shares in the
   origin thread. A repeat Close retries an archive that failed. Looks good stays feedback, so Fix
   still works in the open channel. A Fix follow-up job shares its parent's channel and sets it to
   `processing`; reconcile sets it back to `active` when the follow-up ends.
9. The brief, Full brief, and feedback buttons in the origin thread still find the moved job
   through the origin columns. The Home tab links a moved job to its channel.
10. Every message in a code channel reaches the brain with no tag, triage, or listen mode. Each turn
   gets a note naming the channel's job, so the brain steers that job instead of starting another.
11. The channel calls post no message, so they skip the outbox. The question link goes through
    the outbox and `chooseDisplay` like every Slack post.

## Consequences

- The manifest adds the code channel feature, `code_channels:manage`, `channels:read`,
  `groups:read`, `mpim:read`, and `agent_session_stopped`. The owner reinstalls the app.
- The status follows the job's task, and reconcile sets `active` for a job it finishes. The
  context bar updates only from the task, so a follow-up's PR shows after the next task-driven
  job or not at all.
- A person answers a worker question in the original thread, not in the channel. Answering in
  the channel needs the job's task to run in the channel's session, which Eve 0.88 cannot move.
- Slack's Stop button on the channel stops the brain's turn, not the worker job. The card's Stop
  button still stops the job.
- Not used yet: view tabs, canvases, per-channel slash commands. A diff tab needs the worker's
  diff.
