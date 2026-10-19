import type { Migration } from "../ledger/migrations.ts";

// A dispatch identity for each scheduled fire. The dispatcher inserts (schedule_id, due_at)
// before it sends, so a crash after the send cannot lead to a second session for the same fire.
// Rows from before this migration keep a null due_at and are not unique.
export const scheduleRunsMigration: Migration = {
  version: "009_schedule_run_identity",
  sql: `
    alter table schedule_runs add column due_at timestamptz;
    create unique index schedule_runs_dispatch on schedule_runs (schedule_id, due_at);
    -- One session belongs to one run, so a session cannot bind two runs.
    create unique index schedule_runs_session on schedule_runs (session_id)
      where session_id is not null;
  `,
};
