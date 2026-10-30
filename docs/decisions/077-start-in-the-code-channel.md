# 077. Ask for Start in the code channel

Status: accepted
Date: 2026-10-30

## Context

With code channels on (decision 067), Sym posted the brief and Start in the thread where the
person asked, and moved the job into its code channel only after Start. The thread then held the
brief, the Start answer, and the channel link, which cluttered a shared thread.

Slack also opens a code channel with a quote of the origin message, with the origin's author and
text. When that message mentioned Sym, Slack sent the quote as a new `app_mention`. Eve 0.88 skips
the quote only for plain channel messages, so Sym took a new turn in the channel and proposed the
same job again.

## Decision

1. A job a person must start opens its code channel before the brief posts. The brief and Start
   post in the channel. The channel's status is `suspended` until Start, `processing` while the
   work runs, and `active` after Not now or at the end. The thread shows only Slack's link.
2. After Not now the channel stays open, so the person can revise the brief there. Sym does not
   archive it.
3. A late Start that reconcile picks up sets the channel to `processing` instead of opening
   another channel.
4. Scheduled checks, direct messages, Slack Connect threads, and any thread Slack refuses keep the
   brief in the thread, as before.
5. `onAppMention` and `onMessage` ignore a message with Slack's origin-quote block
   (`agent_channel_origin_context`) in a code channel.

## Consequences

- A proposal that nobody starts leaves an idle code channel. Close or archive removes it.
- Typed approvals for the brief work in the channel, where the proposal lives.
- The brain's capability line tells it that `worker_job` opens the channel, so it says nothing more
  in the thread.
