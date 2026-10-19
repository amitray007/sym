import type { Migration } from "../ledger/migrations.ts";

// Pull request watch state (lib/jobs/pr-wakes.ts). lib/ledger/migrations.ts lists this migration.
export const workerMigration: Migration = {
  version: "007_pr_watch",
  sql: `
    -- The pull request URL the worker was asked to watch. A job asks once per URL.
    alter table jobs add column pr_watched_url text;
    -- Where Sym stopped reading the worker thread for pull request wakes. A worker position.
    alter table jobs add column pr_wake_cursor text
  `,
};
