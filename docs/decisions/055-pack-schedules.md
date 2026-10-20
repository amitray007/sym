# 055. A pack seeds schedules that the owner still approves

Status: accepted
Date: 2026-10-21

## Context

`docs/adopting.md` listed `schedules.yaml` in the pack layout, but Sym ignored it. An adopter had
to ask Sym for each recurring check in chat. Decision 024 requires the owner to approve each
schedule once, and a pack must not widen Sym's rules (decision 026).

## Decision

1. A pack may hold `schedules.yaml`, a list of entries: `key`, `title`, `cron` (UTC), optional
   `channel` (default `channels.default`), and `brief`. The brief uses the `Brief` schema of
   `worker_job`. Unknown fields fail. Each brief project must be a pack project, and keys are
   unique. An error names the file, the entry, and the field, and Sym refuses to start.
2. Migration 017 adds a nullable, unique `pack_key` to `schedules`. The first dispatcher tick of
   each process runs `seedPackSchedules`. A failure logs a warning and retries on the next tick.
3. Seeding is idempotent. A new key becomes a `pending_approval` row owned by the pack owner. A row
   that matches its entry is left alone. A row whose cron, title, channel, or brief changed is
   updated and returns to `pending_approval`, with its approval cleared. A removed key is soft
   deleted. A deleted key that returns is revived as pending. Without a pack, seeding changes
   nothing.
4. When seeding leaves pending rows, one outbox post tells the owner, with a key built from those
   rows, so a re-run posts nothing new.
5. The new tool `schedule_approve` approves a pending row by reference. Its prompt shows the
   cron, project, goal, done-when, and the read-only line. The prompt reads only the tool input,
   so the input repeats the cron and brief from `schedule_list`, and execute refuses a mismatch,
   as `playbook_review` does.

## Consequences

The owner approves each seeded schedule once and again after each change to its brief. A restart
with no change asks nothing. If the process stops after the rows change and before the notice
queues, no notice goes out; `schedule_list` still shows the pending rows. A row revived with
fields identical to an earlier notice reuses that notice's key and posts no new DM.
