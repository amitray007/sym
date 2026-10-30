# 072. Follow-up run boundaries

Status: accepted
Date: 2026-10-30

## Context

A follow-up shares its parent's worker thread. Sending it adds a user message, while the first
status read can still report the parent's completion. Activity alone cannot identify the new run.
Concurrent proposal execution must also preserve the one child already recorded.

## Decision

After send, store the position of the follow-up's echoed user message and the send time. If an
adapter has no echo, use the cursor read after send. Read from the parent's cursor to find the
echo, so delayed parent items stay before the boundary and fast worker replies stay after it.
Serialize sends for one child. Retrying a recorded send keeps its boundary and send time.

Checks ignore user messages and items at or before the boundary. Store whether any worker item
has appeared after it. Once one appears, accept terminal statuses normally. Failed and interrupted
statuses after send end the child immediately, even without new activity. Empty completion gets
at most three checks or five minutes, whichever limit arrives first. Then post the existing
no-summary result. The ledger stores the check count so a watcher restart cannot reset the grace.

A collision on the same request key returns the existing child. Permanent refusals return an
explicit flag. Proposal completion cancels only an explicitly refused, unsent child. A proposal
whose child is still being sent stays approved for recovery. Only recovery sends a refusal DM;
a live click receives its direct answer and the proposal edit.

Test and CI subjects with outcome words in the same sentence reject writer prose outside fact
tokens. This includes succeeded, success, passing, passed, green, and ok. Descriptive sentences
such as "I added a test for the retry that failed before" can also use the plain fallback.
Historical auto-start playbooks display as approved guidance without a trusted label.

## Consequences

The boundary, observed flag, send time, and check count live in Postgres. Both worker fakes echo
sent user messages. Ledger tests cover delayed completion, empty failure and interruption after
either parent outcome, bounded no-summary completion, and simultaneous proposal execution.
