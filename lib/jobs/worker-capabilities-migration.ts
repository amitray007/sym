import type { Migration } from "../ledger/migrations.ts";

export const workerCapabilitiesMigration: Migration = {
  version: "023_worker_capabilities",
  sql: `
    -- Private credentials, kept outside jobs so status tools never serialize them.
    create table worker_capabilities (
      job_id bigint primary key references jobs (id) on delete cascade,
      token text not null unique,
      endpoint text not null
    );
  `,
};
