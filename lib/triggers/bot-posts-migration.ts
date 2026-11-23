import type { Migration } from "../ledger/migrations.ts";

// Decision 101: a message or reaction trigger can opt in to posts by other apps and bots, such
// as alert apps. Existing triggers keep ignoring them.
export const triggerBotPostsMigration: Migration = {
  version: "042_trigger_bot_posts",
  sql: `
    alter table triggers add column include_bots boolean not null default false;
  `,
};
