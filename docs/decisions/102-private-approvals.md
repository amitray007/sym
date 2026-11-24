# 102. Post approvals in the requester's DM, and no approval for the run's own thread

Status: accepted
Date: 2026-11-24

## Context

A trigger run on an alerts channel drafted a summary and called `slack_post` with the alert's
own link as the target. The run already lives in that thread, so the post was its reply there.
Decision 088 says the run's own reply needs no approval. But `slack_post` asked anyway: the
target was in the same channel, and the read-untrusted rule (decision 082) asked for every
`slack_post` in a run.

The approval card then showed the draft to everyone in the alert thread, with Approve and Deny
buttons that only the requester can use.

## Decision

1. A `slack_post` into the session's own thread skips the read-untrusted rule. It is the same as
   replying there. A broadcast mention, a Slack Connect target, and the `SYM_APPROVAL_POSTS`
   setting still apply. `postsInOwnThread` in `lib/slack/slack-post.ts` decides. A failed lookup
   counts as another thread. The tool description tells the brain to reply instead of calling the
   tool for the conversation it is in.
2. The approval cards of `slack_post`, `slack_dm`, `slack_edit`, `slack_bookmark`,
   `slack_canvas`, and `main_thread_post` go to the requester's DM. Only the requester answers
   them (`requesterResponse`). The thread shows Eve's line "Waiting on approval from @person…".
   Decision 104 turns it into the reply once the person answers.
   Sym uses Eve's `approvalChannel` setting, in `lib/slack/approval-place.ts`.
3. Every other request stays in the thread: owner-only approvals (connections, playbooks, Stop),
   because the owner can be someone other than the requester, and Eve questions. A session that
   is already a DM keeps its cards there.
4. In a run, Eve's DM reviewer would be the event's author, such as an alert app. Before the card
   goes out, Sym sets the reviewer to the run's requester, the trigger's or schedule's creator.
   When the run has no allowed requester, the card stays in the thread, where nobody can approve
   it, as before.

Slack's "only visible to you" messages were rejected. Eve does not render approval cards that
way. Slack also drops them when the person reloads or changes devices, so an approval could get
lost.

## Consequences

- People in a shared thread no longer see drafts that wait for someone else's click.
- Typed answers do not change. Sym already checks answers in `onAnswers`, so a typed thread reply
  was never an answer to an Eve request (decision 066).
- The DM card links back to the thread message that started the session.
