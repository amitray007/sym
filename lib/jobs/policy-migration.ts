import type { Migration } from "../ledger/migrations.ts";

// Legacy jobs cannot prove which worker owns their thread and must not resume through Fix.
export const workerIdentityMigration: Migration = {
  version: "022_job_worker_identity",
  sql: `alter table jobs add column worker_identity text`,
};
