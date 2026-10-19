import type { Migration } from "../ledger/migrations.ts";

// Worker sign-in tokens (decision 036, lib/workers/credentials.ts). One row per worker name:
// the pack's `workers[].name`, or "default". lib/ledger/migrations.ts lists this migration.
export const credentialsMigration: Migration = {
  version: "008_worker_credentials",
  sql: `
    create table worker_credentials (
      worker text primary key,
      mcp_url text not null,
      -- The bearer token. A secret: never log it or copy it into another table.
      access_token text not null,
      -- T3 tokens last 30 days and have no refresh token. Null when the worker gave no expiry.
      expires_at timestamptz,
      -- The Slack user ID of the owner who approved the sign-in.
      approved_by text,
      created_at timestamptz not null default now()
    )
  `,
};
