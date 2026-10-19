# 038. Fixes from the second independent review

Status: accepted
Date: 2026-10-20

## Context

A second review by a different model family read `main` after decision 037. It found five
defects. A typed answer could approve an owner-only tool, a silent result could stop recovery,
recovery lost the verifier's verdict, a status-only write could overwrite a newer check, and a
scheduled job could start before its session was bound to the run.

## Decision

- Owner approvals: every owner-only tool sets an approval response policy (`ownerResponse` in
  `lib/owner.ts`). Eve applies it to button clicks and typed answers alike. A non-owner can still
  decline.
- Job revision: each job row has a `revision` that every update increments. A check writes only
  when the revision is the one it read, so a status-only write cannot hide a newer one.
- Stored verdict: `finishJob` saves the verifier's verdict on the row with the `done` status.
  Recovery posts the end message with that verdict.
- End mark: `presentEnd` sets `end_presented_at` once it has decided the end message, including a
  silent clean check. Reconcile looks for finished jobs without that mark, so a silent result is
  not posted again and a missed one is not lost.
- Session binding: a scheduled job's pre-approval waits up to 15 seconds for the dispatcher to
  attach the session to a run that it fired in the last 2 minutes. With no such run, it does not
  wait.

## Consequences

Migration 010 adds `revision`, `verdict`, and `end_presented_at` to `jobs`. Each fix has a test.
