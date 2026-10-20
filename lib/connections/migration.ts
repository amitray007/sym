import type { Migration } from "../ledger/migrations.ts";

// MCP connections the owner adds from Slack (decision 045, lib/connections/rows.ts), and their
// OAuth sign-ins. lib/ledger/migrations.ts lists this migration.
export const connectionsMigration: Migration = {
  version: "012_connections",
  sql: `
    create table connections (
      id bigint generated always as identity primary key,
      -- Eve's connection name: lowercase letters, digits, and single dashes.
      name text not null unique check (coalesce(
        name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(name) between 2 and 31, false)),
      url text not null,
      description text not null default '',
      auth_kind text not null check (coalesce(auth_kind in ('none', 'env', 'oauth'), false)),
      -- Only token connections name an env var, and only a SYM_MCP_<NAME>_TOKEN one.
      env_var text check (env_var ~ '^SYM_MCP_[A-Z0-9_]+_TOKEN$'),
      check (coalesce((auth_kind = 'env') = (env_var is not null), false)),
      status text not null default 'proposed'
        check (coalesce(status in ('proposed', 'active', 'disabled'), false)),
      -- [{ name, description, readOnly, mode }], mode is auto, ask, or hidden.
      tools jsonb not null default '[]' check (coalesce(jsonb_typeof(tools) = 'array', false)),
      created_by text,
      approved_by text,
      approved_at timestamptz,
      check (coalesce(status <> 'active' or approved_at is not null, false)),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table connection_credentials (
      connection_id bigint primary key references connections (id) on delete cascade,
      -- Secrets: never log them or copy them into another table.
      access_token text not null,
      refresh_token text,
      expires_at timestamptz,
      -- The authorization server and the client registration a refresh needs. The registration
      -- can hold a client secret, so treat it like the tokens.
      oauth_client jsonb not null,
      -- The Slack user ID of the owner who approved the sign-in.
      approved_by text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `,
};
