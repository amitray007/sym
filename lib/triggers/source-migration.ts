import type { Migration } from "../ledger/migrations.ts";

// Decision 091: a trigger can fire on a GitHub or Linear event that Eve's channel for that
// service received. Such a trigger watches no Slack channel and always posts in a stored
// destination. `source_filter` holds which events fire it (a repository and event types for
// GitHub, a team and actions for Linear); code reads it, never the brain.
export const sourceTriggersMigration: Migration = {
  version: "041_source_triggers",
  sql: `
    alter table triggers drop constraint triggers_kind_check;
    alter table triggers add constraint triggers_kind_check
      check (kind in ('message', 'reaction', 'webhook', 'github', 'linear'));
    alter table triggers add column source_filter jsonb;
    alter table triggers add constraint triggers_source_filter
      check (coalesce((kind in ('github', 'linear')) = (source_filter is not null), false));
    alter table triggers drop constraint triggers_webhook_destination;
    alter table triggers add constraint triggers_destination
      check (kind in ('message', 'reaction') or destination is not null);
    create index triggers_source on triggers (kind)
      where status = 'active' and kind in ('github', 'linear');
  `,
};
