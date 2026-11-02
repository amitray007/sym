# 081. Slack tools reach other conversations, only for members

Status: accepted
Date: 2026-11-02

## Context

Sym's Slack tools act only where a person talks to it. `slack_react` reacts to the message that
started the turn, and `main_thread_post` posts in a code channel's origin thread (decision 079).
People want to ask for more: post in another channel or thread, react to a linked message, read a
linked thread, and similar actions. Each of these can leak. A non-member could learn what a
private channel holds, or Sym could carry words out of a DM into a channel.

## Decision

1. A set of brain tools acts in other Slack conversations. Each one names its target by message
   link, thread link, channel mention, channel ID, or `#name`. `lib/slack/reach.ts` resolves the
   target and owns the checks. A `#name` resolves only among the channels Sym belongs to.
2. A tool acts only when all of these hold:
   - The requester is on Sym's allow-list.
   - Sym is a member of the target conversation, and the conversation is not archived.
   - The requester is a member of the target conversation.
3. Every refusal reads the same: "I can't reach that conversation." The reply is identical for a
   channel that does not exist, a channel Sym is not in, a channel the requester is not in, and
   a Slack error. A non-member learns nothing about the target.
4. Each post names the person who asked for it ("Posted for @name").
5. When the source conversation is private (a DM, a group DM, or a private channel), a post that
   carries text into another conversation waits for the requester to approve it. Eve's tool
   approval shows the target and the text. An unknown source counts as private.
6. Reading is one-way by default. A read tool returns content only when the source conversation
   cannot show it to a non-member of the target: the target is the source, the target is a public
   channel, or the source is the requester's DM with Sym.
7. Code holds these rules, not the prompt. The tools never post on their own; the brain calls
   them only when a person asks.

The tools land in this order, each with its own PR:

| Tool | Does | Status |
|---|---|---|
| `slack_post` | Post in a channel, or in the thread of a linked message | Built |
| `slack_react` with a link | React to a linked message | Planned |
| `slack_read` | Read a linked message or thread | Planned |
| `slack_edit`, `slack_delete` | Change or remove Sym's own posts | Planned |
| `slack_dm` | Send a person a DM | Planned |
| `slack_pin` | Pin a message or add a channel bookmark (`pins:write`, `bookmarks:write`) | Planned |
| `slack_canvas` | Write a canvas (`canvases:write`) | Planned |
| `slack_user` | Look up a person's name, time zone, and status | Planned |

## Consequences

- The membership check reads the target's member list on each call. A very large channel costs
  several Slack calls.
- Posting into a DM goes through `slack_dm`, so `slack_post` refuses a DM target.
- New scopes need an app reinstall when their tool lands.
- Message search stays out. The classic Slack search API needs a user token.
