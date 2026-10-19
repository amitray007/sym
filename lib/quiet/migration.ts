import type { Migration } from "../ledger/migrations.ts";

// Owner settings and learning feedback. The statements use `if not exists`, so a local test
// harness can apply them on top of a registered migration without failing.
export const quietMigration: Migration = {
  version: "005_settings_feedback",
  sql: `
    -- Owner settings, one row per key. Quiet mode keeps its end time under 'quiet_until' as an
    -- ISO 8601 string. No row, or a past time, means quiet mode is off.
    create table if not exists settings (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );

    -- What people say about Sym's work (docs/learning.md): feedback buttons, reactions on Sym's
    -- messages, and fixes. A row may belong to a job or stand alone.
    create table if not exists feedback (
      id bigint generated always as identity primary key,
      job_id bigint references jobs (id),
      slack_user text not null,
      kind text not null check (kind in ('thumbs_up', 'thumbs_down', 'reaction', 'fix')),
      value text not null default '',
      channel text,
      message_ts text,
      created_at timestamptz not null default now()
    );

    -- Slack retries events, so one person's same reaction to one message counts once.
    create unique index if not exists feedback_once on feedback (slack_user, kind, message_ts, value)
      where message_ts is not null and kind <> 'fix';
    create index if not exists feedback_job on feedback (job_id) where job_id is not null;
  `,
};
