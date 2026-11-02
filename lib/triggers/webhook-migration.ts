import type { Migration } from "../ledger/migrations.ts";

// Decision 090: a webhook trigger fires on a signed HTTP request to its own URL. It watches no
// Slack channel, so `channel` is null for it, and its runs always post in a stored destination.
// `hook_id` is the unguessable part of its URL. The row stores no secret: Sym derives each
// trigger's signing secret from SYM_WEBHOOK_KEY, the hook ID, and `secret_version`, and a
// rotation bumps the version. The secret reaches its creator only through a one-time reveal page.
export const webhookTriggersMigration: Migration = {
  version: "040_webhook_triggers",
  sql: `
    alter table triggers drop constraint triggers_kind_check;
    alter table triggers add constraint triggers_kind_check
      check (kind in ('message', 'reaction', 'webhook'));
    alter table triggers alter column channel drop not null;
    alter table triggers add constraint triggers_watched_channel
      check (coalesce((kind in ('message', 'reaction')) = (channel is not null), false));
    alter table triggers add column hook_id text unique;
    alter table triggers add column secret_version int not null default 1;
    alter table triggers add constraint triggers_hook
      check (coalesce((kind = 'webhook') = (hook_id is not null), false));
    alter table triggers add constraint triggers_webhook_destination
      check (kind <> 'webhook' or destination is not null);
    -- One-time links that show a webhook secret to its creator. Only a hash of the token is
    -- stored. A link shows the secret of the version it was made for, once, before it expires.
    create table webhook_reveals (
      token_hash text primary key,
      trigger_id bigint not null references triggers (id),
      secret_version int not null,
      owner text not null,
      expires_at timestamptz not null,
      revealed_at timestamptz,
      created_at timestamptz not null default now()
    );
  `,
};
