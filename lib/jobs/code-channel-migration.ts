import type { Migration } from "../ledger/migrations.ts";

// A started job can move from its Slack thread into its own Slack code channel (decision 067).
// Then slack_channel names the code channel and slack_thread_ts is null.
export const jobCodeChannelMigration: Migration = {
  version: "024_job_code_channel",
  sql: `alter table jobs add column code_channel boolean not null default false`,
};
