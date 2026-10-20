# 059. The trust ladder: an approved playbook earns a start without the click

Status: accepted
Date: 2026-10-21

## Context

Every job asked for Start, except runs of an approved schedule (decision 024). The design
(docs/learning.md) promotes a job class from "approve each run" to "auto" after clean runs, and
only the owner changes it. A job class needs a definition that is not hardcoded to a kind of task.

## Decision

1. A job class is an approved playbook. The brain sets the brief's optional `playbook` field when
   a reviewed playbook fits the request. `worker_job` ties the job to the approved row with that
   name (`jobs.playbook_id`); a name with no approved playbook, or a rule, ties nothing. The brief
   post names the playbook, so the owner sees the class of each job before trusting it.
2. When a job ends, `presentEnd` records `jobs.outcome` once: `clean` when it is done with a
   result block, no open questions, and no concerns from the rule or model checks; otherwise
   `unclean`. A 👎 or a Fix on the job later makes it `unclean`. Scheduled checks and cancelled
   jobs do not count: a person's Stop says nothing about the playbook. The outcome is recorded
   before the end mark, so recovery re-presents a job whose outcome a crash lost.
3. After `SYM_TRUST_RUNS` (default 5, at least 2) clean finished runs in a row, Sym sends the
   owner one notice per streak. The owner calls `playbook_trust` with mode `auto`; the tool needs the owner's approval
   and the clean runs. `playbooks.start_mode` then reads `auto`.
4. `worker_job` skips the Start prompt when the job's playbook is approved and `auto`, the turn
   comes from a Slack person, and the playbook already ran clean on the brief's project. Naming a
   trusted playbook for another project still asks. The brief still posts, with a line that names the trusted
   playbook. The job records `auto_started`.
5. An unclean run, a 👎, or a Fix sets the playbook back to `ask` at once and tells the owner. A
   job that got a 👎 while it ran demotes again when it ends, in case the owner trusted the
   playbook in between.
   The owner can also call `playbook_trust` with mode `ask`. Trust sits on the approved row, so a
   new version of a playbook starts at `ask`.
6. Migration `021_trust_ladder` adds `start_mode`, `trust_changed_by`, and `trust_changed_at` to
   `playbooks`, and `playbook_id`, `outcome`, and `auto_started` to `jobs`.

## Consequences

The approval invariant holds: a writing job asks for Start until the owner promotes its playbook.
The brain cannot grant trust: it can only name a playbook, and code reads the start mode from the
ledger. A brain that names a trusted playbook for unrelated work on the same project starts that
job without a click, so the owner should trust only narrow playbooks; the first concern or 👎
ends the trust. Sym
counts only what its checks see, so the verifier (`SYM_VERIFIER=on`) makes a clean run mean more.
