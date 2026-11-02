# 082. Posts in Sym's voice, owned edits, and post safeguards

Status: accepted
Date: 2026-11-02

## Context

Decision 081 added `slack_post` and planned more tools. The owner asked for three changes. Posts
should read in Sym's voice, without a "Posted for @name" line. Sym should edit and delete its own
posts and add and remove reactions. And the review gaps should close: broadcast pings, Slack
Connect channels, and no limit on posts.

## Decision

1. Sym posts in its own voice. It mentions the requester only when they ask for that. The ledger
   table `requested_posts` records who asked for each post from `slack_post` and
   `main_thread_post`. The row is written before the post is sent, keyed by its outbox key, so a
   post still pending in the outbox counts toward the cap and stays the requester's. The post's
   Slack ts comes from the outbox row.
2. `slack_edit` and `slack_delete` change or remove such a post. Only the person who asked for it
   can have Sym change it, and they must still pass the decision 081 checks for that channel.
   The target is a message link, or the requester's latest post in the conversation. An edit
   goes through the outbox as `chat.update`; a delete calls `chat.delete`.
3. `slack_react` adds or removes Sym's reaction on a linked message when a person asks, under the
   decision 081 membership checks. Without a link, it reacts to the turn's message as before, and
   it can take that reaction off on request. A removal keeps its row in the reactions ledger, so
   it never frees a slot in the thread's hourly reaction cap.
4. The requester approves a post or an edit first when it does any of these (`main_thread_post`
   checks only the first, since its target is the thread the conversation came from):
   - pings a whole channel or a user group (`<!here>`, `<!channel>`, `<!everyone>`,
     `<!subteam^…>`, or their plain `@` forms);
   - goes to a Slack Connect channel, shared with another organization;
   - carries words out of a DM or private channel into another conversation (decision 081).
5. Each person gets 10 posts an hour through Sym, across `slack_post` and `main_thread_post`. A
   lock per requester keeps parallel calls under the cap.
6. The evals stub every new tool, so an eval run never posts.

## Consequences

- Readers see the post as Sym's. Who asked lives only in the ledger.
- Edits and deletes work only on posts made after this change.
- Reactions on request have no hourly cap. The membership check limits who can ask.
