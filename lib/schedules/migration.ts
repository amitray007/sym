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
