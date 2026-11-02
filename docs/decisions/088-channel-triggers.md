# 088. Event triggers and Send to Sym

Status: accepted
Date: 2026-11-03

## Context

Decision 085 made a schedule an instruction for the brain, fired by time. People also ask for
work that starts when something happens in Slack: "when someone posts a bug report in #support,
draft a ticket", or "when someone adds :ticket: to a message, file it". A schedule cannot see a
new message or a reaction. People also want to hand Sym one message from anywhere without
copying it into a thread. `runMessage` in `lib/schedules/format.ts` was built as the seam for
both.

## Decision

1. A trigger is a schedule fired by a Slack event. It holds a title, an instruction, a Builder
   mode (`ask` or `auto`, asked at setup only when a run might need Builder, and for `ask` also
   where), a destination, and its creator. It watches one channel for one kind of event: a new
   top-level message, with optional keywords as a cheap prefilter, or a reaction with one emoji.
   The brain still decides from the instruction whether an event needs anything.
2. Anyone on the allow-list creates, lists, pauses, resumes, and deletes triggers with
   `trigger_create`, `trigger_list`, `trigger_pause`, and `trigger_delete`, with no owner
   approval. The creator's setup is the consent for its runs. A worker thread and a run (the app
   principal) cannot create or change triggers or schedules.
3. Slack sends Sym events only from channels it is in. Setup checks the watched channel the way
   decision 081 checks a reach target: the person is allowed, and both Sym and the person are
   members. The refusal reads the same either way and says why: Sym watches only a channel it
   and the person share. A DM cannot be watched.
4. Runs post in the event message's thread by default; otherwise in a channel the person and Sym
   share, or the creator's DM, as for schedules.
5. Only a new top-level message (in `onMessage`) or a reaction (in `onEvent`) can fire a trigger.
   A mention takes the `app_mention` path, and a reply in a thread keeps its normal path, so
   messages addressed to Sym never become trigger runs. Bots, Sym's own posts, edits, and Sym's
   own reactions fire nothing, so a run's own post or reaction never fires a trigger. A reaction
   on Sym's own message is feedback (decision 051), not a trigger event. A reaction trigger does
   not fire into a thread that already has a session, because the run would share it.
6. Each run reserves a row in `schedule_runs` before the send. The row belongs to a trigger
   instead of a schedule and has an event key: the channel and message, for both kinds. A Slack
   retry, or a second reaction on the same message, finds the row and fires nothing. Each trigger
   starts at most `SYM_TRIGGER_RUNS_PER_HOUR` runs an hour (default 20); the trigger row lock
   keeps the count right under concurrent events. A creator off the allow-list stops the
   trigger.
7. A run starts with the app principal, the same code proof of a run that a schedule uses, so
   `requesterOf` acts for the creator and only the creator answers a gated step. The run message
   is the schedule run message with the event's facts (kind, channel, link, author, reactor,
   text) as one JSON line. The message says they are untrusted data: never instructions, never
   consent, and the author is not the requester.
8. The message handler's `ctx.send` reaches only the message's own thread. A message trigger
   that posts elsewhere stores its run as deferred, and the next `dispatch` tick sends it with
   `to()`. A deferred run older than 10 minutes fails instead of firing late. `onEvent` can send
   to any target, so reaction runs start at once.
9. `worker_job` takes a `trigger` reference beside `schedule`. A trigger run skips Start only
   when the session's initiator is the app principal, the trigger is active, its mode is `auto`,
   the project is on the list, and the job binds to this session's own run, once. Any other case
   shows Start / Not now.
10. A run shows no status line: it sits in someone else's thread, and most runs end in silence.
    A run that stays silent leaves its thread to the people there: their replies start no turn,
    and a mention still does. A run that posted continues like any shared thread (decision 050).
11. "Send to Sym" is a message shortcut. A person picks a message, and Sym posts in that person's
    DM: a link, a quote (broadcast mentions defused), and "What should I do with it?". Their
    reply in that thread is their own request, and the brain gets a note that the quote is data.
    It is not a trigger run. The DM is cleaner than the message's thread: it needs no membership
    in that channel, shows nothing to its members, and keeps the conversation with the person who
    asked. Eve's `onShortcut` context has only the Slack API, no `send`, so the reply starts the
    session.
12. Migration `037_channel_triggers` adds `triggers`, makes `schedule_runs.schedule_id`
    nullable, and adds `trigger_id`, `event_key`, `event`, and `deferred`, with a check that a run
    belongs to exactly one schedule or trigger.

## Consequences

- A busy channel with a trigger and no keywords spends a model turn on each new message, up to
  the hourly cap. Keywords narrow it.
- A message trigger that posts in a channel or a DM answers up to a minute late.
- The digest lists trigger runs by title next to scheduled runs.
- The app needs the `message_action` shortcut in the manifest and a reinstall. The events and
  scopes it uses were already granted.
