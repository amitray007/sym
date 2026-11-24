# 105. Standing approvals for posts and group pings

Status: accepted
Date: 2026-11-24

## Context

A message trigger on an alerts channel read each alert and posted a summary that pinged the
on-call user group. Every run sent the creator an approval card first, because decision 082 asks
before any post that pings a user group, and before a run's post outside its own thread. The
creator wanted the summary and the ping to go out on their own. The only way to stop the card was
`SYM_APPROVAL_POSTS=never`, which turns the click off for everyone and every channel.

A person should be able to tell Sym "don't ask me before pinging @on-call in #alerts", and Sym
should stop asking from the next post on.

## Decision

1. A standing approval is a row in `standing_approvals`: a person, a channel, and the group pings
   allowed there. It covers that person's `slack_post` posts in that channel, in their own turns
   and in the schedule and trigger runs that act for them (decision 085). Code skips the click
   when the post would need one only for these reasons: a ping the person named, words from a
   private conversation, or a run's read of untrusted text.
2. A ping the person did not name still asks. So does a Slack Connect channel, and a broadcast
   form that names no readable ping. Allow-lists, membership checks, and the hourly cap still run.
3. `standing_approval_add` saves one. It runs only on the person's own turn, never in a run, and
   only for a channel that the person and Sym both belong to. The person confirms it once with a
   click in their DM, so pasted text cannot grant it alone. `SYM_APPROVAL_POSTS` still sets that
   click.
4. `standing_approval_list` shows the person's own standing approvals. `standing_approval_remove`
   takes one ping or the whole channel back, with no click.
5. A ping is a user group ID (`<!subteam^S…>`), `here`, `channel`, or `everyone`. A group's
   name alone has no ID, so the brain passes the mention the person used.
6. The brain saves one only when the person asks. After a person approves a post that pinged a
   group, or a post from one of their runs, it may offer once to stop asking.

## Consequences

- An alert trigger can post its summary and ping on-call with no card, after one confirmation.
- Each person controls their own approvals from chat. The deployment settings of decision 099
  stay the global switch.
- Edits, DMs, bookmarks, canvases, and `main_thread_post` keep their rules. They can take
  standing approvals later if people ask for them.
