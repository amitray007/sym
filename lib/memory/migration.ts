import type { Migration } from "../ledger/migrations.ts";

// Layer 1 memory facts (docs/learning.md). lib/ledger/migrations.ts lists this migration.
export const memoryMigration: Migration = {
  version: "004_memory",
  sql: `
    create table memory_facts (
      id bigint generated always as identity primary key,
      -- Eve's opaque scope key. Every read and write filters on it, so one person never sees
      -- another person's facts.
      scope_key text not null,
      slot text not null,
      text text not null check (length(text) between 1 and 2000),
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      -- Deleting sets this. The row stays for audit and is never read again.
      deleted_at timestamptz
    );
    create index memory_facts_scope_idx on memory_facts (scope_key, slot, updated_at desc)
      where deleted_at is null;
    create index memory_facts_search_idx on memory_facts
      using gin (to_tsvector('simple', text)) where deleted_at is null;
  `,
};
