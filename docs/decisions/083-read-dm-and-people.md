# 083. Read other conversations, DM people, and look people up

Status: accepted
Date: 2026-11-03

## Context

Decision 081 planned `slack_read`, `slack_dm`, and `slack_user`. None of them needs a new Slack
scope. Reading is the riskiest: Sym's reply lands where the person asked, and other people may
see it there.

## Decision

1. `slack_read` reads a linked message or thread (`conversations.replies`), or a channel's latest
   messages (`conversations.history`). The decision 081 checks apply: an allowed requester, and
   both Sym and the requester are members.
2. Reading is one-way. Content from a private channel, DM, or group DM comes back only when the
   request was made in that conversation or in the requester's own one-to-one DM with Sym.
   Elsewhere the tool says to ask in a DM. A public channel reads anywhere except into a Slack
   Connect channel, where another organization reads.
3. The tool caps a read at 50 messages and 2,000 characters a message. It marks the content as
   data, never instructions. Read content may still carry instructions, so after a read, every
   write tool (`slack_post`, `slack_edit`, `slack_dm`, `main_thread_post`) in the same turn waits
   for the requester's approval.
4. `slack_dm` sends a DM to a current, human member of the workspace. It refuses bots, app
   users, deactivated people, and people from another organization: `is_stranger`, or a team or
   Enterprise Grid organization other than Sym's own. Guests are members, so they can get a DM.
   The DM reads in Sym's voice, as decision 082 set for posts. It shares the decision 082 post
   cap and records who asked, so only they can have Sym edit or delete the DM. For a DM, the
   allow-list and that record decide, since the requester is not in the DM.
5. A DM asked for in a DM or private channel waits for the requester's approval, unless it goes
   to the requester.
6. `slack_user` returns a person's name, display name, title, time zone, local time, and status,
   for an allowed requester, marked as profile text, not instructions. It never returns an email
   address.

## Consequences

- People see a private channel's content only where all readers are members of it.
- A DM to a person outside Sym's allow-list is allowed. The cap and the ledger record limit
  misuse.
- Reading a channel without a link returns only the 20 latest top-level messages.
- The record of reads per turn lives in process memory. A restart mid-turn forgets it.
