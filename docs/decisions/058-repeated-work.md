# 058. The brain finds repeated work and drafts playbooks

Status: accepted
Date: 2026-10-21

## Context

The weekly `learn` pass groups feedback with fixed rules (decision 033). It cannot see that
people keep asking for the same kind of work in different words, so the owner had to notice the
pattern and write the playbook. The owner wants Sym to notice it, without rules written for one
kind of task.

## Decision

1. A weekly `repeat` schedule (Monday 06:30 UTC) runs only when code finds at least 3 jobs that
   finished since the last review. It then opens a session as the app principal in the digest
   channel, or the pack's default channel when the digest goes to a DM. Without either, it stays
   off.
2. The brain reads the briefs of recent finished jobs with `repeated_work` (60 days, newest 40,
   scheduled checks left out) and judges what repeats. Only briefs reach it, never worker output,
   because worker output can carry injected text.
3. The brain calls `repeated_work_propose` once with every pattern it found (at most 3), each with
   a name, a body in its own words, and the jobs that show the pattern. Code checks the evidence: at least 3 different recent
   finished jobs, and a name with no live proposal, approval, or rejection in the last 28 days.
   The row is a `playbook` with source `repeat` and the job IDs as evidence (migration
   `020_playbook_repeat_source`).
4. The call queues one review notice for all its proposals, to the digest channel or the owner's
   DM, so a review is one ping. The brain posts nothing itself. The owner approves with `playbook_review`, as for any proposal.
5. The owner can also ask for a review at any time. Both tools refuse worker threads and anyone
   but the owner or the app principal.

## Consequences

Sym spends one model session a week at most, and only after enough new work. A proposal is text
the owner reads and approves before it loads, so a wrong guess costs one click to reject.
Approved playbooks guide how the brain writes later briefs; the trust ladder builds on them.
