# 104. The waiting line of a DM approval becomes the reply

Status: accepted
Date: 2026-11-24

## Context

Decision 102 sends some approval cards to the requester's DM. Eve then posts "Waiting on
approval from @person…" in the thread. When the person answers, Eve edits that line to
"Answered: Approve by @person." Sym's reply then follows as a new message. The thread gets two
messages for one action, and the first one tells nobody anything useful.

## Decision

- When a DM approval settles, Sym edits the waiting line to hold the reply that follows. The
  thread shows one message: "Waiting on approval…" while the person decides, then a short line
  such as "Posted it in #releases."
- The renderer's `interaction.settled` handler takes the line's timestamp off Eve's card record
  before Eve runs, so Eve skips its "Answered" edit. `takeApprovalAnnouncement` in
  `lib/slack/approval-place.ts` does this. The next reply of the turn goes through the outbox as
  a `chat.update` of that line (`replaceTs` in `queueReply`).
- When the turn ends without a reply, Sym deletes the line.
- The brain's instructions ask for one short line after an approval: what it did, or that it did
  not do it.
- The DM card keeps Eve's settled state, so the requester still sees the answer there.

## Consequences

- The handler reads Eve's internal `interactionCards` state. An Eve upgrade that renames it
  brings back the "Answered" line and a separate reply. Nothing breaks.
- A reply over 12,000 characters still posts as a document. The waiting line then stays until
  the turn ends and is deleted.
