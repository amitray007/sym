import type { Migration } from "../ledger/migrations.ts";

// A started job can move from its Slack thread into its own Slack code channel (decision 067).
// Then slack_channel names the code channel, slack_thread_ts is null, and the origin columns keep
// the thread the job came from, where Eve still asks the job's questions.
export const jobCodeChannelMigration: Migration = {
  version: "024_job_code_channel",
  sql: `
    alter table jobs add column code_channel boolean not null default false;
    alter table jobs add column origin_channel text;
    alter table jobs add column origin_thread_ts text;
  `,
};
