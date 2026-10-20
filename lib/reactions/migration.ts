import type { Migration } from "../ledger/migrations.ts";

// Reactions Sym added (decision 051). lib/ledger/migrations.ts lists this migration.
export const reactionsMigration: Migration = {
  version: "015_reactions",
  sql: `
    -- The message that started the session's latest turn. A tool reacts on it.
    alter table session_threads add column if not exists message_ts text;

    -- One row per reaction Sym added. The key allows one reaction per message. The index serves
    -- the per-thread cap. thread_ts is the thread root, or the message itself outside a thread.
    create table reactions (
      channel_id text not null,
      message_ts text not null,
      thread_ts text not null,
      name text not null,
      created_at timestamptz not null default now(),
      primary key (channel_id, message_ts)
    );
    create index reactions_thread_idx on reactions (channel_id, thread_ts, created_at);
  `,
};
