import type { Migration } from "../ledger/migrations.ts";

// Schedules and their runs (docs/architecture.md, flow 2; decision 008). Sym owns schedules, so
// the ledger holds them. Same rules as decision 016: a CHECK passes on NULL, so each is wrapped
// in coalesce(..., false).
export const schedulesMigration: Migration = {
  version: "003_schedules",
  sql: `
    create table schedules (
      id bigint generated always as identity primary key,
      -- Five fields, evaluated in UTC.
      cron text not null check (length(trim(cron)) > 0),
      title text not null,
      -- A worker_job brief. The owner approved this exact text.
      brief jsonb not null check (coalesce(jsonb_typeof(brief) = 'object', false)),
      -- Each fire opens a new thread in this channel.
      channel text not null,
      owner text not null,
      status text not null default 'pending_approval' check (status in (
        'pending_approval', 'active', 'paused', 'deleted'
      )),
      approved_by text,
      approved_at timestamptz,
      -- A claim runs out at this time, so a crashed dispatcher does not block the row.
      lease_until timestamptz,
      last_fired_at timestamptz,
      next_fire_at timestamptz,
      created_at timestamptz not null default now(),
      -- An active schedule has an approver and a next fire time.
      constraint schedules_active_ready check (coalesce(
        status <> 'active'
        or (approved_by is not null and approved_at is not null and next_fire_at is not null),
        false
      ))
    );

    create index schedules_due on schedules (next_fire_at) where status = 'active';

    create table schedule_runs (
      id bigint generated always as identity primary key,
      schedule_id bigint not null references schedules (id),
      fired_at timestamptz not null,
      session_id text,
      outcome text not null default 'started' check (outcome in (
        'started', 'all_clear', 'needs_attention', 'failed'
      )),
      job_id bigint references jobs (id)
    );

    create index schedule_runs_fired on schedule_runs (fired_at);
  `,
};

// A schedule seeded from the pack's schedules.yaml keeps its key here (decision 055). Chat-made
// rows have no key. The unique index lets a seed find its row again.
export const schedulePackKeyMigration: Migration = {
  version: "017_schedule_pack_key",
  sql: `
    alter table schedules add column pack_key text;
    create unique index schedules_pack_key on schedules (pack_key) where pack_key is not null;
  `,
};

// Decision 085: a schedule holds an instruction for the brain, not a stored brief. Anyone allowed
// creates one, active at once. `builder` says whether a run may start Builder work without a
// click. A row fires on a cron or once at `run_at`, and a one-time row ends as `done`. An old
// row keeps its brief inside the instruction; an approved one keeps its click-free start. A row
// that waited for approval was never approved, so it becomes paused.
export const agentSchedulesMigration: Migration = {
  version: "034_agent_schedules",
  sql: `
    alter table schedules add column instruction text;
    alter table schedules add column builder text not null default 'ask'
      check (builder in ('ask', 'auto'));
    alter table schedules add column run_at timestamptz;
    alter table schedules alter column cron drop not null;

    update schedules set
      instruction = 'Start the builder with this brief.' || E'\\n\\n\`\`\`brief\\n'
        || jsonb_pretty(brief) || E'\\n\`\`\`',
      builder = case when approved_by is not null then 'auto' else 'ask' end;
    update schedules set status = 'paused', next_fire_at = null, lease_until = null
      where status = 'pending_approval';

    alter table schedules drop constraint schedules_active_ready;
    alter table schedules drop constraint schedules_status_check;
    alter table schedules add constraint schedules_status_check
      check (status in ('active', 'paused', 'done', 'deleted'));
    alter table schedules alter column status set default 'active';
    alter table schedules alter column instruction set not null;
    alter table schedules add constraint schedules_instruction
      check (length(trim(instruction)) > 0);
    -- Exactly one of a cron and a one-time run.
    alter table schedules add constraint schedules_timing
      check (coalesce((cron is null) <> (run_at is null), false));
    alter table schedules add constraint schedules_active_ready
      check (coalesce(status <> 'active' or next_fire_at is not null, false));
    alter table schedules drop column brief, drop column approved_by, drop column approved_at;
  `,
};
